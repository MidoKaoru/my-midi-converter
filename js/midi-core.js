// main.jsから呼び出されるメイン関数
export async function processMidiData(file, shuffleType) {
    const arrayBuffer = await file.arrayBuffer();
    const midi = new window.Midi(arrayBuffer);
    
    const PPQ = midi.header.ppq;
    // ハーフタイムなら8分音符(PPQ/2)、レギュラーなら4分音符(PPQ)を基準にする
    const RES = (shuffleType === 'half') ? PPQ / 2 : PPQ;
    const tolerance = RES * 0.08; 

    // Tickを最も近いグリッドに吸着させる関数
    function quantizeTick(tick) {
        const beat = Math.floor(tick / RES);
        let relTick = tick % RES;
        
        if (relTick >= RES - tolerance) return (beat + 1) * RES;
        if (relTick <= tolerance) return beat * RES;

        const trip1 = Math.round(RES / 3);
        const trip2 = Math.round(RES * 2 / 3);
        const half  = Math.round(RES / 2);

        // シャッフル位置の吸着
        if (Math.abs(relTick - trip1) <= tolerance || Math.abs(relTick - trip2) <= tolerance || Math.abs(relTick - half) <= tolerance) {
            return beat * RES + half;
        }

        // 吸着をすり抜けた値は、強制的に16分音符グリッドに丸め込む
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
                if (!positions.some(p => Math.abs(p - relTick) <= tolerance)) {
                    positions.push(relTick);
                }
            });

            // 意図的な3連符などは保護
            const hasTrip1 = positions.some(p => Math.abs(p - trip1) <= tolerance);
            if (hasTrip1 || positions.length >= 3) {
                protectedBeats.add(parseInt(beatIndex));
            }
        }

        track.notes.forEach(note => {
            const beatIndex = Math.floor(note.ticks / RES);
            if (protectedBeats.has(beatIndex)) return; 

            const originalStartTick = note.ticks;
            const originalEndTick = note.ticks + note.durationTicks;

            const newStartTick = quantizeTick(originalStartTick);
            const newEndTick = quantizeTick(originalEndTick);

            // 始点をイーブンに更新
            note.ticks = newStartTick;
            
            // デュレーションを16分音符の倍数に強制整形（MuseScoreでのゴミ休符を完全防止）
            const rawDuration = newEndTick - newStartTick;
            const durationGrid = PPQ / 4; 
            const quantizedDuration = Math.round(rawDuration / durationGrid) * durationGrid;
            note.durationTicks = Math.max(durationGrid, quantizedDuration); 
        });
    });

    // ==========================================
    // トラックとメタデータのバグ回避・クリーンアップ
    // ==========================================

    // 1. Tone.jsのキー情報書き出しバグを回避するため、破損データを意図的に削除（MSPの「Key=?」対策）
    midi.header.keySignatures = [];

    // 2. マスタートラックの悪立ちを防ぐため、すべてのシーケンス名/トラック名を消去
    delete midi.header.name;
    midi.tracks.forEach(track => {
        delete track.name;
    });

    // 3. （念のため）音符を持たない完全に空のトラックがあれば削除
    midi.tracks = midi.tracks.filter(track => track.notes.length > 0);

    return midi;
}