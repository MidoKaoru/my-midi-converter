import { parseMidi, writeMidi } from 'https://esm.sh/midi-file';

export async function processMidiData(file, shuffleType) {
    const arrayBuffer = await file.arrayBuffer();
    const originalUint8 = new Uint8Array(arrayBuffer);

    // ==========================================
    // 【第1フェーズ：抽出】Track 0 からのみメタデータを抽出
    // ==========================================
    const originalParsed = parseMidi(originalUint8);
    const originalPPQ = originalParsed.header.ticksPerBeat;
    const savedMetaEvents = [];
    
    if (originalParsed.tracks.length > 0) {
        let absoluteTick = 0;
        // 重複を防ぐため、マスタートラック(0)からのみ調合・拍子・テンポを抽出
        originalParsed.tracks[0].forEach(event => {
            absoluteTick += event.deltaTime;
            if (event.type === 'keySignature' || event.type === 'timeSignature' || event.type === 'setTempo') {
                savedMetaEvents.push({ ...event, _abs: absoluteTick });
            }
        });
    }

    // ==========================================
    // 【第2フェーズ：変換 (Tone.js)】ノートのみクオンタイズ
    // ==========================================
    const midi = new window.Midi(arrayBuffer);
    const PPQ = midi.header.ppq; 
    const RES = (shuffleType === 'half') ? PPQ / 2 : PPQ;
    const tolerance = RES * 0.08; 

    function quantizeTick(tick) {
        const beat = Math.floor(tick / RES);
        let relTick = tick % RES;
        if (relTick >= RES - tolerance) return (beat + 1) * RES;
        if (relTick <= tolerance) return beat * RES;
        const trip1 = Math.round(RES / 3);
        const trip2 = Math.round(RES * 2 / 3);
        const half  = Math.round(RES / 2);
        if (Math.abs(relTick - trip1) <= tolerance || Math.abs(relTick - trip2) <= tolerance || Math.abs(relTick - half) <= tolerance) {
            return beat * RES + half;
        }
        const subGrid = RES / 4; 
        const snappedRelTick = Math.round(relTick / subGrid) * subGrid;
        return beat * RES + snappedRelTick;
    }

    midi.tracks.forEach(track => {
        const beats = {};
        track.notes.forEach(note => {
            const beatIndex = Math.floor(note.ticks / RES);
            if (!beats[beatIndex]) beats[beatIndex] = [];
            beats[beatIndex].push(note);
        });

        const protectedBeats = new Set();
        const trip1 = Math.round(RES / 3);
        for (const beatIndex in beats) {
            const positions = [];
            beats[beatIndex].forEach(note => {
                const relTick = note.ticks % RES;
                if (!positions.some(p => Math.abs(p - relTick) <= tolerance)) positions.push(relTick);
            });
            if (positions.some(p => Math.abs(p - trip1) <= tolerance) || positions.length >= 3) {
                protectedBeats.add(parseInt(beatIndex));
            }
        }

        track.notes.forEach(note => {
            const beatIndex = Math.floor(note.ticks / RES);
            if (protectedBeats.has(beatIndex)) return; 
            const newStartTick = quantizeTick(note.ticks);
            const newEndTick = quantizeTick(note.ticks + note.durationTicks);
            note.ticks = newStartTick;
            const rawDuration = newEndTick - newStartTick;
            const durationGrid = PPQ / 4; 
            note.durationTicks = Math.max(durationGrid, Math.round(rawDuration / durationGrid) * durationGrid); 
        });
    });

    // Tone.js側のメタデータを念のため削除
    midi.header.keySignatures = [];
    midi.header.tempos = [];
    midi.header.timeSignatures = [];
    delete midi.header.name;
    midi.tracks.forEach(track => delete track.name);
    midi.tracks = midi.tracks.filter(track => track.notes.length > 0);

    const toneExportedUint8 = midi.toArray();

    // ==========================================
    // 【第3フェーズ：修復と統合】数学的に正確な位置へパッチ当て
    // ==========================================
    const finalParsed = parseMidi(toneExportedUint8);
    const exportPPQ = finalParsed.header.ticksPerBeat;
    const scale = exportPPQ / originalPPQ;

    // メタイベントの位置を、新しいPPQスケールに合わせて再計算
    const processedMetaEvents = savedMetaEvents.map(event => ({
        ...event,
        _abs: Math.round(event._abs * scale)
    }));

    function mergeTracks(track1, track2, metaEvents) {
        let time1 = 0;
        const abs1 = track1.map(e => { time1 += e.deltaTime; return { ...e, _abs: time1 }; });
        let time2 = 0;
        const abs2 = track2.map(e => { time2 += e.deltaTime; return { ...e, _abs: time2 }; });

        // Tone.jsが残した可能性のある不要なメタイベントを排除
        const isAllowed = (e) => e.type !== 'timeSignature' && e.type !== 'keySignature' && e.type !== 'setTempo' && e.type !== 'endOfTrack';
        const filtered1 = abs1.filter(isAllowed);
        const filtered2 = abs2.filter(isAllowed);

        // 抽出した正確なメタイベントと統合してソート
        const merged = [...filtered1, ...filtered2, ...metaEvents].sort((a, b) => {
            if (a._abs !== b._abs) return a._abs - b._abs;
            // 同時刻の場合は、メタイベント(拍子や調合など)をノート(音符)より前に置く
            const aIsNote = ('channel' in a) ? 1 : 0;
            const bIsNote = ('channel' in b) ? 1 : 0;
            return aIsNote - bIsNote; 
        });

        // 最後に End of Track を付与
        const maxTime = merged.length > 0 ? merged[merged.length - 1]._abs : 0;
        merged.push({ type: 'endOfTrack', deltaTime: 0, _abs: maxTime });

        // 絶対時間から再び deltaTime へ変換
        let current = 0;
        return merged.map(e => {
            const dt = Math.max(0, Math.round(e._abs - current));
            current = e._abs;
            
            // ★致命的なバグの修正箇所：計算したdtをしっかりと代入する
            const newEv = { ...e, deltaTime: dt }; 
            
            delete newEv._abs;
            return newEv;
        });
    }

    // マスタートラック(0)と楽器トラック(1)をマージ
    if (finalParsed.tracks.length >= 2) {
        finalParsed.tracks[0] = mergeTracks(finalParsed.tracks[0], finalParsed.tracks[1], processedMetaEvents);
        finalParsed.tracks.splice(1, 1);
    } else {
        finalParsed.tracks[0] = mergeTracks(finalParsed.tracks[0], [], processedMetaEvents);
    }

    return {
        toArray: () => new Uint8Array(writeMidi(finalParsed))
    };
}