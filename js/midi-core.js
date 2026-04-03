import { parseMidi, writeMidi } from 'https://esm.sh/midi-file';

export async function processMidiData(file, defaultShuffleType, sections = []) {

    const arrayBuffer = await file.arrayBuffer();
    const originalUint8 = new Uint8Array(arrayBuffer);

    // ==========================================
    // 【第1フェーズ：抽出】
    // ==========================================
    const originalParsed = parseMidi(originalUint8);
    const originalPPQ = originalParsed.header.ticksPerBeat;

    const savedMetaEvents = [];

    if (originalParsed.tracks.length > 0) {
        let absoluteTick = 0;
        originalParsed.tracks[0].forEach(event => {
            absoluteTick += event.deltaTime;
            if (event.type === 'keySignature' || event.type === 'timeSignature' || event.type === 'setTempo') {
                savedMetaEvents.push({ ...event, _abs: absoluteTick });
            }
        });
    }

    // ==========================================
    // 【第2フェーズ：変換】
    // ==========================================
    const midi = new window.Midi(arrayBuffer);
    const PPQ = midi.header.ppq;

    function getModeForMeasure(measureIndex) {
        for (const sec of sections) {
            if (measureIndex + 1 >= sec.start && measureIndex + 1 <= sec.end) {
                return sec.mode;
            }
        }
        return defaultShuffleType;
    }

    function detectTuplets(beats, RES, tolerance, mode, PPQ, measureGroups, mIdx) {
        const protectedBeats = new Set();

        if (mode === 'half') {
            const quarterNote = PPQ;

            const quarterBeats = {};
            measureGroups[mIdx].forEach(note => {
                const quarterBeatIndex = Math.floor(note.ticks / quarterNote);
                if (!quarterBeats[quarterBeatIndex]) quarterBeats[quarterBeatIndex] = [];
                quarterBeats[quarterBeatIndex].push(note);
            });

            for (const quarterBeatIndex in quarterBeats) {
                const notes = quarterBeats[quarterBeatIndex];

                const ornamentThreshold = Math.round(PPQ / 10);
                const substantialNotes = notes.filter(note =>
                    note.durationTicks > ornamentThreshold
                );

                const uniqueSubstantialTicks = new Set(substantialNotes.map(n => n.ticks));
                if (uniqueSubstantialTicks.size >= 5) {
                    notes.forEach(note => {
                        const beatIndex = Math.floor(note.ticks / RES);
                        protectedBeats.add(beatIndex);
                    });
                } else if (substantialNotes.length === 3) {
                    const sorted = [...substantialNotes].sort((a, b) => a.ticks - b.ticks);
                    const interval1 = sorted[1].ticks - sorted[0].ticks;
                    const interval2 = sorted[2].ticks - sorted[1].ticks;
                    const tripletInterval = Math.round(PPQ / 3);
                    const tripletTolerance = Math.round(tripletInterval * 0.2);
                    const isTriplet = Math.abs(interval1 - tripletInterval) <= tripletTolerance &&
                                     Math.abs(interval2 - tripletInterval) <= tripletTolerance;
                    if (isTriplet) {
                        notes.forEach(note => {
                            const beatIndex = Math.floor(note.ticks / RES);
                            protectedBeats.add(beatIndex);
                        });
                    }
                }
            }

        } else {
            const tupletPatterns = {
                triplet:    [0, 1, 2].map(i => Math.round(RES * i / 3)),
                quintuplet: [0, 1, 2, 3, 4].map(i => Math.round(RES * i / 5)),
                septuplet:  [0, 1, 2, 3, 4, 5, 6].map(i => Math.round(RES * i / 7))
            };

            for (const beatIndex in beats) {
                const notes = beats[beatIndex];
                const positions = [];

                notes.forEach(note => {
                    const relTick = note.ticks % RES;
                    if (!positions.some(p => Math.abs(p - relTick) <= tolerance)) {
                        positions.push(relTick);
                    }
                });

                const nonGridPositions = positions.filter(pos => {
                    const nearZero = Math.abs(pos) <= tolerance;
                    const nearHalf = Math.abs(pos - RES / 2) <= tolerance;
                    const nearFull = Math.abs(pos - RES) <= tolerance;
                    return !nearZero && !nearHalf && !nearFull;
                });

                if (nonGridPositions.length < 2) continue;

                for (const [name, pattern] of Object.entries(tupletPatterns)) {
                    let matchCount = 0;

                    for (const patternPos of pattern) {
                        const isGridPos = (Math.abs(patternPos) <= tolerance) ||
                                         (Math.abs(patternPos - RES / 2) <= tolerance) ||
                                         (Math.abs(patternPos - RES) <= tolerance);
                        if (isGridPos) continue;

                        if (positions.some(pos => Math.abs(pos - patternPos) <= tolerance)) {
                            matchCount++;
                        }
                    }

                    const nonGridPatternPositions = pattern.filter(p => {
                        return !(Math.abs(p) <= tolerance ||
                                 Math.abs(p - RES / 2) <= tolerance ||
                                 Math.abs(p - RES) <= tolerance);
                    });

                    const requiredMatches = Math.ceil(nonGridPatternPositions.length * 0.8);

                    if (matchCount >= requiredMatches && matchCount >= 2) {
                        protectedBeats.add(parseInt(beatIndex));
                        break;
                    }
                }
            }
        }

        return protectedBeats;
    }

    const tempoChangeTicks = savedMetaEvents
        .filter(e => e.type === 'setTempo')
        .map(e => e._abs);

    const measureTickMap = [];

    const timeSigEvents = savedMetaEvents
        .filter(e => e.type === 'timeSignature')
        .sort((a, b) => a._abs - b._abs);

    if (timeSigEvents.length === 0) {
        console.warn('No Time Signature found, assuming 4/4');
    }

    if (midi.tracks.length > 0) {
        const allNotes = midi.tracks.flatMap(t => t.notes);
        if (allNotes.length === 0) {
            throw new Error('MIDIファイルに音符が見つかりません');
        }

        const maxTick = Math.max(...allNotes.map(n => n.ticks + n.durationTicks), 0);

        let currentTick = 0;
        let measureIndex = 0;
        let currentBeatsPerMeasure = 4;
        let currentBeatUnit = 4;
        let timeSigIdx = 0;

        // tick=0 の拍子記号を先に適用
        if (timeSigEvents.length > 0 && timeSigEvents[0]._abs === 0) {
            currentBeatsPerMeasure = timeSigEvents[0].numerator || 4;
            currentBeatUnit = timeSigEvents[0].denominator || 4;
            timeSigIdx = 1;
        }

        while (currentTick < maxTick) {
            // 現在の小節開始 tick に一致する拍子変更を適用
            while (timeSigIdx < timeSigEvents.length && timeSigEvents[timeSigIdx]._abs <= currentTick) {
                currentBeatsPerMeasure = timeSigEvents[timeSigIdx].numerator || 4;
                currentBeatUnit = timeSigEvents[timeSigIdx].denominator || 4;
                timeSigIdx++;
            }

            const currentTicksPerMeasure = PPQ * (currentBeatsPerMeasure * 4 / currentBeatUnit);
            const mode = getModeForMeasure(measureIndex);

            measureTickMap.push({
                measureIndex,
                startTick: currentTick,
                endTick: currentTick + currentTicksPerMeasure,
                mode
            });

            currentTick += currentTicksPerMeasure;
            measureIndex++;
        }
    }

    midi.tracks.forEach((track) => {
        const measureGroups = {};
        track.notes.forEach(note => {
            const measure = measureTickMap.find(m =>
                note.ticks >= m.startTick && note.ticks < m.endTick
            );
            if (measure) {
                const mIdx = measure.measureIndex;
                if (!measureGroups[mIdx]) measureGroups[mIdx] = [];
                measureGroups[mIdx].push(note);
            } else {
                console.warn(`Note at tick ${note.ticks} has no measure assigned.`);
            }
        });

        for (const mIdx in measureGroups) {
            const measure = measureTickMap[parseInt(mIdx)];
            if (!measure) {
                console.error(`Measure ${mIdx} not found in map.`);
                continue;
            }

            const mode = measure.mode;
            const RES = (mode === 'half') ? PPQ / 2 : PPQ;
            const tolerance = RES * 0.08;

            function quantizeTick(tick, duration) {
                const beat = Math.floor(tick / RES);
                let relTick = tick % RES;
                const tripletSixteenthDuration = Math.round(PPQ / 6);

                if (duration >= tripletSixteenthDuration) {
                    if (relTick <= tolerance) return { tick: beat * RES, zone: 'BEAT' };

                    const half = RES / 2;
                    if (Math.abs(relTick - half) <= tolerance * 2) return { tick: beat * RES + half, zone: 'HALF(tol)' };

                    const zone1End = RES / 4;
                    const zone2End = RES * 3 / 4;

                    if (relTick < zone1End) return { tick: beat * RES, zone: 'BEAT(z1)' };
                    else if (relTick < zone2End) return { tick: beat * RES + RES / 2, zone: 'HALF(z2)' };
                    else return { tick: (beat + 1) * RES, zone: 'NEXT(z3)' };
                }

                if (relTick >= RES - tolerance) return { tick: (beat + 1) * RES, zone: 'NEXT(edge)' };
                if (relTick <= tolerance) return { tick: beat * RES, zone: 'BEAT(edge)' };

                const zone1End = RES / 4;
                const zone2End = RES * 3 / 4;
                if (relTick >= zone1End && relTick < zone2End) return { tick: beat * RES + RES / 2, zone: 'HALF(short)' };

                const subGrid = RES / 4;
                const snappedRelTick = Math.round(relTick / subGrid) * subGrid;
                return { tick: beat * RES + snappedRelTick, zone: `SUB(${snappedRelTick})` };
            }

            const beats = {};
            measureGroups[mIdx].forEach(note => {
                const beatIndex = Math.floor(note.ticks / RES);
                if (!beats[beatIndex]) beats[beatIndex] = [];
                beats[beatIndex].push(note);
            });

            const protectedBeats = detectTuplets(beats, RES, tolerance, mode, PPQ, measureGroups, mIdx);

            measureGroups[mIdx].forEach(note => {
                const beatIndex = Math.floor(note.ticks / RES);
                const isNearTempoChange = tempoChangeTicks
                    .filter(t => t > 0)
                    .some(tick => Math.abs(note.ticks - tick) <= tolerance);

                const relTick = note.ticks % RES;
                const ratio = (relTick / RES).toFixed(3);
                const zone1End = RES / 4;
                const zone2End = RES * 3 / 4;
                const zoneLabel = relTick <= tolerance ? 'BEAT'
                    : relTick >= RES - tolerance ? 'NEXT'
                    : relTick < zone1End ? 'z1(→BEAT)'
                    : relTick < zone2End ? 'z2(→HALF)'
                    : 'z3(→NEXT)';
                console.log(
                    `[M${parseInt(mIdx)+1} beat${beatIndex}] tick=${note.ticks} relTick=${relTick}(${ratio}) zone=${zoneLabel} ` +
                    `(RES=${RES} z1<${zone1End} z2<${zone2End} tol=${tolerance.toFixed(1)}) ` +
                    `dur=${note.durationTicks} protected=${protectedBeats.has(beatIndex)} nearTempo=${isNearTempoChange} mode=${mode}`
                );

                if (protectedBeats.has(beatIndex) || isNearTempoChange) {
                    return;
                }

                const { tick: newStartTick, zone } = quantizeTick(note.ticks, note.durationTicks);

                let newEndTick;
                const eighthNoteDuration = PPQ / 2;
                const sixteenthNoteDuration = PPQ / 4;
                const tripletSixteenthDuration = Math.round(PPQ / 6);

                if (mode === 'regular') {
                    if (note.durationTicks >= tripletSixteenthDuration) {
                        // 8分音符（240 ticks）を基本単位として最も近い倍数に丸める
                        const multiplier = Math.max(1, Math.round(note.durationTicks / eighthNoteDuration));
                        newEndTick = newStartTick + multiplier * eighthNoteDuration;
                    } else {
                        const minGrid = PPQ / 16;
                        const adjustedDur = Math.round(note.durationTicks / minGrid) * minGrid;
                        newEndTick = newStartTick + adjustedDur;
                    }
                } else {
                    if (note.durationTicks >= tripletSixteenthDuration) {
                        // 16分音符を基本単位として最も近い倍数に丸める
                        const multiplier = Math.max(1, Math.round(note.durationTicks / sixteenthNoteDuration));
                        newEndTick = newStartTick + multiplier * sixteenthNoteDuration;
                    } else {
                        const minGrid = PPQ / 16;
                        const adjustedDur = Math.round(note.durationTicks / minGrid) * minGrid;
                        newEndTick = newStartTick + adjustedDur;
                    }
                }

                console.log(
                    `  → [${zone}] startTick: ${note.ticks} → ${newStartTick}  dur: ${note.durationTicks} → ${newEndTick - newStartTick}`
                );

                note.ticks = newStartTick;
                note.durationTicks = newEndTick - newStartTick;
            });
        }
    });

    midi.header.keySignatures = [];
    midi.header.tempos = [];
    midi.header.timeSignatures = [];
    delete midi.header.name;
    midi.tracks.forEach(track => delete track.name);
    midi.tracks = midi.tracks.filter(track => track.notes.length > 0);

    const toneExportedUint8 = midi.toArray();

    // ==========================================
    // 【第3フェーズ：修復と統合】
    // ==========================================
    const finalParsed = parseMidi(toneExportedUint8);
    const exportPPQ = finalParsed.header.ticksPerBeat;
    const scale = exportPPQ / originalPPQ;

    const processedMetaEvents = savedMetaEvents.map(event => ({
        ...event,
        _abs: Math.round(event._abs * scale)
    }));

    function mergeTracks(track1, track2, metaEvents) {
        let time1 = 0;
        const abs1 = track1.map(e => { time1 += e.deltaTime; return { ...e, _abs: time1 }; });
        let time2 = 0;
        const abs2 = track2.map(e => { time2 += e.deltaTime; return { ...e, _abs: time2 }; });

        const isAllowed = (e) => e.type !== 'timeSignature' && e.type !== 'keySignature' && e.type !== 'setTempo' && e.type !== 'endOfTrack';
        const filtered1 = abs1.filter(isAllowed);
        const filtered2 = abs2.filter(isAllowed);

        const merged = [...filtered1, ...filtered2, ...metaEvents].sort((a, b) => {
            if (a._abs !== b._abs) return a._abs - b._abs;
            const aIsNote = ('channel' in a) ? 1 : 0;
            const bIsNote = ('channel' in b) ? 1 : 0;
            return aIsNote - bIsNote;
        });

        const maxTime = merged.length > 0 ? merged[merged.length - 1]._abs : 0;
        merged.push({ type: 'endOfTrack', deltaTime: 0, _abs: maxTime });

        let current = 0;
        return merged.map(e => {
            const dt = Math.max(0, Math.round(e._abs - current));
            current = e._abs;
            const newEv = { ...e, deltaTime: dt };
            delete newEv._abs;
            return newEv;
        });
    }

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
