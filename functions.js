<script>
        // ══════════════════════════════════════════════════════════
        //   SHARED CONSTANTS & UTILITIES
        // ══════════════════════════════════════════════════════════
        const FINGER_TIPS = [4, 8, 12, 16, 20], FINGER_PIP = [3, 6, 10, 14, 18];
        const HAND_CONN = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17]];
        const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
        const POSE_CONN = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28]];
        const COOLDOWN_FRAMES = 8;

        function d2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }
        function validHand(lms) { return Array.isArray(lms) && lms.length === 21 && lms[0] != null }
        function extended(lms, f) {
            if (!lms) return false;
            const tip = lms[FINGER_TIPS[f]], pip = lms[FINGER_PIP[f]], wrist = lms[0];
            if (!tip || !pip || !wrist) return false;
            if (f === 0) { const mcp = lms[2]; if (!mcp) return false; return d2(tip, wrist) > d2(mcp, wrist) * 1.3 }
            return d2(tip, wrist) > d2(pip, wrist);
        }
        function countExtended(lms) { let n = 0; for (let i = 0; i < 5; i++)if (extended(lms, i)) n++; return n }
        function fmt(lm) { return lm ? `${lm.x.toFixed(2)},${lm.y.toFixed(2)}` : '—' }

        function showToast(msg, type = 'info') {
            const t = document.getElementById('toast');
            t.textContent = msg; t.className = `toast ${type} show`;
            setTimeout(() => t.classList.remove('show'), 2500);
        }

        // ══════════════════════════════════════════════════════════
        //   DETECTOR LOGIC
        // ══════════════════════════════════════════════════════════
        let holistic, camera, running = false, frameCount = 0, lastTime = 0;
        const canvas = document.getElementById('outputCanvas'), ctx = canvas.getContext('2d');
        const video = document.getElementById('inputVideo');
        const cooldowns = {};
        const history = [];

        // ══════════════════════════════════════════════════════════
        //   TTS ENGINE — Web Speech API
        // ══════════════════════════════════════════════════════════
        const tts = window.speechSynthesis;
        let ttsEnabled = true;          // dapat di-toggle oleh pengguna
        let ttsCooldown = 0;            // frame-based cooldown antar ucapan
        const TTS_COOLDOWN = 45;        // ~45 frame ≈ 1.5 detik pada 30fps
        let _lastSpoken = '';           // hindari mengulang kalimat yang sama terus-menerus

        /** Toggle TTS on/off dan update tampilan tombol */
        function toggleTTS() {
            ttsEnabled = !ttsEnabled;
            const btn = document.getElementById('ttsBtn');
            if (ttsEnabled) {
                btn.textContent = '🔊 Suara: ON';
                btn.className = 'tts-on';
                if (tts) tts.cancel();
            } else {
                btn.textContent = '🔇 Suara: OFF';
                btn.className = 'tts-off';
                if (tts) tts.cancel();
            }
        }

        /** Internal: kirim teks ke speech synthesis */
        function speakText(text) {
            if (!tts || !ttsEnabled) return;
            tts.cancel();
            const utt = new SpeechSynthesisUtterance(text);
            utt.lang = 'id-ID';
            utt.rate = 0.95;
            utt.pitch = 1;
            utt.volume = 1;
            tts.speak(utt);
        }

        /** Ucapkan satu nama gesture (dengan cooldown & deduplikasi) */
        function speakGesture(name) {
            if (!ttsEnabled || ttsCooldown > 0) return;
            if (_lastSpoken === name) return;
            _lastSpoken = name;
            ttsCooldown = TTS_COOLDOWN;
            speakText(name);
        }

        /**
         * Ucapkan beberapa gesture yang terdeteksi bersamaan.
         * Contoh: ["AYAH", "IBU"] → "AYAH dan IBU"
         */
        function speakGestureList(names) {
            if (!ttsEnabled || ttsCooldown > 0) return;
            const key = names.join('|');
            if (_lastSpoken === key) return;
            _lastSpoken = key;
            ttsCooldown = TTS_COOLDOWN;
            const phrase = names.join(' dan ');
            speakText(phrase);
        }

        // Generated gestures runtime registry
        let GENERATED_GESTURES = {};
        let GENERATED_DESCS = {};

        function getPalmOrientation(lms, isRight) {
            const w = lms[0], m5 = lms[5], m17 = lms[17];
            if (!w || !m5 || !m17) return 'unknown';
            const cross = (m5.x - w.x) * (m17.y - w.y) - (m5.y - w.y) * (m17.x - w.x);
            return isRight ? (cross < 0 ? 'palm' : 'back') : (cross > 0 ? 'palm' : 'back');
        }
        function updateOrientationUI(rh, lh) {
            const rhTag = document.getElementById('rhOrientTag'), lhTag = document.getElementById('lhOrientTag');
            if (rh) { const p = getPalmOrientation(rh, true) === 'palm'; rhTag.textContent = p ? 'Telapak' : 'Punggung'; rhTag.className = `orient-tag ${p ? 'tag-palm' : 'tag-back'}`; }
            else { rhTag.textContent = '—'; rhTag.className = 'orient-tag tag-none'; }
            if (lh) { const p = getPalmOrientation(lh, false) === 'palm'; lhTag.textContent = p ? 'Telapak' : 'Punggung'; lhTag.className = `orient-tag ${p ? 'tag-palm' : 'tag-back'}`; }
            else { lhTag.textContent = '—'; lhTag.className = 'orient-tag tag-none'; }
        }
        function updateFingers(lms, side) {
            const p = side === 'right' ? 'fR' : 'fL';
            for (let i = 0; i < 5; i++) {
                const b = document.getElementById(`${p}${i}`), s = b.querySelector('.fs');
                if (!lms) { b.classList.remove('extended'); s.textContent = '—'; continue; }
                const e = extended(lms, i); b.classList.toggle('extended', e); s.textContent = e ? 'Buka' : 'Tutup';
            }
        }
        function setDotIndicator(id, on) { const el = document.getElementById(id); if (el) el.classList.toggle('active', on) }
        function setGestureCard(name, detected) {
            const card = document.getElementById('card-' + name), badge = document.getElementById('badge-' + name);
            if (card) card.classList.toggle('detected', detected);
            if (badge) badge.textContent = detected ? 'Ya' : '—';
        }
        function updateOutput(name, confidence) {
            const pct = confidence != null ? Math.round(confidence * 100) : null;
            document.getElementById('outputMain').textContent = name;
            const desc = GENERATED_DESCS[name] || '';
            const confStr = pct != null ? ` · ${pct}% confidence` : '';
            document.getElementById('outputDesc').textContent = desc + confStr;
            const bar = document.getElementById('outputConfBar');
            if (bar && pct != null) {
                bar.style.width = pct + '%';
                bar.style.background = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
            }
            const entry = pct != null ? `${name} (${pct}%)` : name;
            history.unshift(entry);
            if (history.length > 6) history.pop();
            const hl = document.getElementById('historyList');
            hl.innerHTML = history.length ? history.map(h => `<div class="history-item">${h}</div>`).join('') : '<span class="history-empty">Kosong</span>';
        }

        // Pose helpers
        function wristAboveNose(pose, side) { const w = pose[side === 'right' ? 16 : 15], n = pose[0]; return w && n && w.visibility >= 0.4 && w.y < n.y }
        function wristBelowShoulder(pose, side) { const w = pose[side === 'right' ? 16 : 15], s = pose[side === 'right' ? 12 : 11]; return w && s && w.visibility >= 0.3 && w.y > s.y + 0.05 }
        function wristNearWaist(pose, side) { const w = pose[side === 'right' ? 16 : 15], s = pose[side === 'right' ? 12 : 11], h = pose[side === 'right' ? 24 : 23]; if (!w || !s || w.visibility < 0.3) return false; return w.y > s.y + 0.05 && w.y < (h ? h.y + 0.05 : s.y + 0.4) }
        function thumbPinkyDist(lms) { const t = lms[4], p = lms[20]; return (t && p) ? d2(t, p) : 1 }

        let _gestureFeatures = {};

        // ══════════════════════════════════════════════════════════
        //   SIMILARITY ENGINE
        // ══════════════════════════════════════════════════════════
        const SIMILARITY_THRESHOLD = 0.70;

        function lmDist(a, b) {
            return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
        }

        function handPresenceMultiplier(feat, rh, lh) {
            const lhPresent = validHand(lh);
            const rhPresent = validHand(rh);
            if (feat && feat.usesBothHands) {
                if (!lhPresent || !rhPresent) return 0.0;
                return 1.0;
            } else {
                if (lhPresent && rhPresent) return 0.0;
                if (lhPresent && !feat.usesRightHand) return 1.0;
                if (lhPresent) return 0.0;
                return 1.0;
            }
        }

        function interHandProximitySim(liveRH, liveLH, sampleRH, sampleLH) {
            if (!liveRH || !liveLH || !sampleRH || !sampleLH) return 0.5;
            const rhRefScale = lmDist(sampleRH[0], sampleRH[9]) || 0.1;
            const sampleDists = [8, 12, 16].map(i => lmDist(sampleLH[8], sampleRH[i]) / rhRefScale);
            const sampleMinDist = Math.min(...sampleDists);
            const lhRefScale = lmDist(liveRH[0], liveRH[9]) || 0.1;
            const liveDists = [8, 12, 16].map(i => lmDist(liveLH[8], liveRH[i]) / lhRefScale);
            const liveMinDist = Math.min(...liveDists);
            const diff = Math.abs(liveMinDist - sampleMinDist);
            return Math.max(0, 1 - diff / 1.5);
        }

        function normalizeHand(lms) {
            if (!lms || lms.length < 21) return null;
            const wrist = lms[0];
            const midMCP = lms[9];
            const palmScale = Math.hypot(midMCP.x - wrist.x, midMCP.y - wrist.y) || 1;
            return lms.map(l => ({
                x: (l.x - wrist.x) / palmScale,
                y: (l.y - wrist.y) / palmScale,
                z: ((l.z || 0) - (wrist.z || 0)) / palmScale
            }));
        }

        function landmarkSim(lmsA, lmsB) {
            if (!lmsA || !lmsB) return 0;
            const nA = normalizeHand(lmsA), nB = normalizeHand(lmsB);
            if (!nA || !nB) return 0;
            let dist = 0;
            for (let i = 0; i < 21; i++) {
                dist += Math.hypot(nA[i].x - nB[i].x, nA[i].y - nB[i].y, nA[i].z - nB[i].z);
            }
            return Math.max(0, 1 - dist / 12);
        }

        function fingerVecSim(lmsA, lmsB) {
            if (!lmsA || !lmsB) return 0.5;
            const vecA = [0, 1, 2, 3, 4].map(i => extended(lmsA, i) ? 1 : 0);
            const vecB = [0, 1, 2, 3, 4].map(i => extended(lmsB, i) ? 1 : 0);
            const weights = [0.25, 0.25, 0.20, 0.15, 0.15];
            let score = 0;
            for (let i = 0; i < 5; i++) {
                if (vecA[i] === vecB[i]) score += weights[i];
            }
            return score;
        }

        function orientSim(lmsA, lmsB, isRight) {
            const oA = getPalmOrientation(lmsA, isRight);
            const oB = getPalmOrientation(lmsB, isRight);
            return oA === oB ? 1 : 0.3;
        }

        function tpDistSim(lmsA, lmsB) {
            if (!lmsA || !lmsB) return 0.5;
            const dA = thumbPinkyDist(lmsA), dB = thumbPinkyDist(lmsB);
            return Math.max(0, 1 - Math.abs(dA - dB) / 0.4);
        }

        function poseSim(poseA, poseB, feat) {
            if (!poseA || !poseB) return feat && feat.usesPose ? 0 : 1;
            const side = feat && feat.usesRightHand ? 'right' : 'left';
            const wIdx = side === 'right' ? 16 : 15;
            const wA = poseA[wIdx], wB = poseB[wIdx];
            if (!wA || !wB) return 0.5;
            const dY = Math.abs(wA.y - wB.y);
            return Math.max(0, 1 - dY / 0.3);
        }

        function handShapeScore(liveHand, sampleHand, isRight) {
            if (!liveHand || !sampleHand) return 0;
            return landmarkSim(liveHand, sampleHand) * 0.30 +
                fingerVecSim(liveHand, sampleHand) * 0.45 +
                orientSim(liveHand, sampleHand, isRight) * 0.15 +
                tpDistSim(liveHand, sampleHand) * 0.10;
        }

        function computeGestureSimilarity(name, rh, lh, face, pose) {
            const feat = _gestureFeatures[name];
            const fn = GENERATED_GESTURES[name];
            if (!fn) return 0;
            const presenceMult = handPresenceMultiplier(feat, rh, lh);
            if (presenceMult === 0.0) return 0;
            const dbEntry = gestureDB[name];
            if (!dbEntry || !dbEntry.samples || dbEntry.samples.length === 0) {
                let detected = false;
                try { detected = fn(rh, lh, face, pose) } catch (e) { }
                return (detected ? 1.0 : 0.0) * presenceMult;
            }
            let boolPass = false;
            try { boolPass = fn(rh, lh, face, pose) } catch (e) { }
            let bestScore = 0;
            for (const sample of dbEntry.samples) {
                const slm = sample.landmarks;
                if (!slm) continue;
                let score = 0, weights = 0;
                const isRight = !feat || feat.usesRightHand !== false;
                if (feat && feat.usesBothHands) {
                    if (rh && slm.rightHand) { score += handShapeScore(rh, slm.rightHand, true) * 0.40; weights += 0.40; }
                    if (lh && slm.leftHand) { score += handShapeScore(lh, slm.leftHand, false) * 0.30; weights += 0.30; }
                    const proxSim = interHandProximitySim(rh, lh, slm.rightHand, slm.leftHand);
                    score += proxSim * 0.30; weights += 0.30;
                } else {
                    const liveHand = isRight ? rh : lh;
                    const sampleHand = isRight ? slm.rightHand : slm.leftHand;
                    if (liveHand && sampleHand) { score += handShapeScore(liveHand, sampleHand, isRight); weights += 1; }
                    else if (!liveHand && !sampleHand) { score += 0.5; weights += 1; }
                    else { score += 0; weights += 1; }
                }
                if (feat && feat.usesPose && slm.pose) {
                    const ps = poseSim(pose, slm.pose, feat);
                    score += ps * 0.12; weights += 0.12;
                }
                const normalized = weights > 0 ? score / weights : 0;
                let finalScore = boolPass ? normalized : Math.min(normalized, 0.55);
                finalScore *= presenceMult;
                if (finalScore > bestScore) bestScore = finalScore;
            }
            return Math.min(1, bestScore);
        }

        function findSimilarGestures(scores, name) {
            const myScore = scores[name];
            if (myScore < SIMILARITY_THRESHOLD) return [];
            return Object.entries(scores)
                .filter(([n, s]) => n !== name && s >= SIMILARITY_THRESHOLD && Math.abs(s - myScore) <= 0.06)
                .map(([n]) => n);
        }

        // ── processGestures: Similarity-based confidence scoring ──
        function processGestures(rh, lh, face, pose) {
            const names = Object.keys(GENERATED_GESTURES);
            if (names.length === 0) return;

            const scores = {};
            for (const name of names) {
                scores[name] = computeGestureSimilarity(name, rh, lh, face, pose);
            }

            const sorted = [...names].sort((a, b) => scores[b] - scores[a]);
            const topName = sorted[0];
            const topScore = scores[topName] || 0;

            sorted.forEach((name, rank) => {
                const conf = scores[name];
                const pct = Math.round(conf * 100);
                const isValid = conf >= SIMILARITY_THRESHOLD;
                const isTop = rank === 0 && isValid;

                const card = document.getElementById('card-' + name);
                const badge = document.getElementById('badge-' + name);
                const cbar = document.getElementById('cbar-' + name);
                const dot = document.getElementById('dot-' + name);
                const rankpill = document.getElementById('rankpill-' + name);
                const simtag = document.getElementById('simtag-' + name);

                if (card) {
                    card.classList.toggle('top-match', isTop);
                    card.classList.toggle('detected', isValid);
                    card.classList.toggle('below-threshold', !isValid && conf < 0.4);
                }
                if (badge) {
                    badge.textContent = conf > 0.01 ? pct + '%' : '—';
                    badge.className = 'gesture-badge' + (conf >= 0.7 ? ' pct-high' : conf >= 0.5 ? ' pct-med' : conf >= 0.3 ? ' pct-low' : '');
                }
                if (cbar) {
                    const cls = conf >= 0.7 ? 'conf-high' : conf >= 0.5 ? 'conf-med' : 'conf-low';
                    cbar.style.width = pct + '%';
                    cbar.className = 'confidence-bar ' + cls;
                }
                if (dot) {
                    dot.style.background = isTop ? '#22c55e' : isValid ? '#3b82f6' : conf >= 0.4 ? '#7c3aed' : '#1e2535';
                }
                if (rankpill) {
                    rankpill.style.display = isTop ? 'inline-block' : 'none';
                }
                if (simtag) {
                    const similars = findSimilarGestures(scores, name);
                    if (similars.length > 0 && isValid) {
                        simtag.style.display = 'inline-block';
                        simtag.textContent = '≈ mirip: ' + similars.join(', ');
                    } else {
                        simtag.style.display = 'none';
                    }
                }
            });

            // Re-sort DOM cards by score
            const grid = document.getElementById('generatedGestureGrid');
            if (grid) {
                sorted.forEach(name => {
                    const card = document.getElementById('card-' + name);
                    if (card) grid.appendChild(card);
                });
            }

            // Output top gesture if above threshold AND clearly better than #2
            if (topScore >= SIMILARITY_THRESHOLD) {
                const secondScore = sorted.length > 1 ? (scores[sorted[1]] || 0) : 0;
                const margin = topScore - secondScore;
                if (margin >= 0.05) {
                    if ((cooldowns[topName] || 0) <= 0) {
                        updateOutput(topName, topScore);
                        cooldowns[topName] = COOLDOWN_FRAMES;
                    }
                }
            }

            // ── TTS: Kumpulkan semua gesture di atas threshold ──────
            // Jika hanya satu → sebut namanya saja
            // Jika lebih dari satu → sebut semua dengan "dan" di antaranya
            const aboveThreshold = sorted.filter(n => scores[n] >= SIMILARITY_THRESHOLD);
            if (aboveThreshold.length === 1) {
                speakGesture(aboveThreshold[0]);
            } else if (aboveThreshold.length > 1) {
                speakGestureList(aboveThreshold);
            }

            // Decrement cooldowns
            for (const name of names) {
                if ((cooldowns[name] || 0) > 0) cooldowns[name]--;
            }
            // Decrement TTS cooldown setiap frame
            if (ttsCooldown > 0) ttsCooldown--;
        }

        // Drawing
        function drawDots(lms, color, r) { ctx.fillStyle = color; for (const lm of lms) { ctx.beginPath(); ctx.arc(lm.x * canvas.width, lm.y * canvas.height, r, 0, Math.PI * 2); ctx.fill() } }
        function drawLines(lms, pairs, color, lw) { ctx.strokeStyle = color; ctx.lineWidth = lw; for (const [a, b] of pairs) { const A = lms[a], B = lms[b]; if (!A || !B) continue; ctx.beginPath(); ctx.moveTo(A.x * canvas.width, A.y * canvas.height); ctx.lineTo(B.x * canvas.width, B.y * canvas.height); ctx.stroke() } }
        function drawFace(lms) {
            if (!lms || !lms.length) return;
            ctx.strokeStyle = 'rgba(0,200,224,0.25)'; ctx.lineWidth = 0.7; ctx.beginPath();
            FACE_OVAL.forEach((i, idx) => { const l = lms[i]; if (!l) return; idx === 0 ? ctx.moveTo(l.x * canvas.width, l.y * canvas.height) : ctx.lineTo(l.x * canvas.width, l.y * canvas.height) });
            ctx.stroke();
            ctx.fillStyle = 'rgba(0,200,224,0.4)';
            for (let i = 0; i < lms.length; i += 6) { const l = lms[i]; ctx.beginPath(); ctx.arc(l.x * canvas.width, l.y * canvas.height, 1, 0, Math.PI * 2); ctx.fill() }
            ctx.fillStyle = '#00c8e0';
            for (const i of [33, 133, 159, 145, 362, 263, 0, 17, 61, 291, 234, 454]) { const l = lms[i]; if (!l) continue; ctx.beginPath(); ctx.arc(l.x * canvas.width, l.y * canvas.height, 2.5, 0, Math.PI * 2); ctx.fill() }
        }
        function drawHand(lms, lineColor, dotColor, tipColor, label) {
            drawLines(lms, HAND_CONN, lineColor, 1.5); drawDots(lms, dotColor, 2.5);
            ctx.fillStyle = tipColor;
            for (const i of FINGER_TIPS) { if (!lms[i]) continue; ctx.beginPath(); ctx.arc(lms[i].x * canvas.width, lms[i].y * canvas.height, 5, 0, Math.PI * 2); ctx.fill() }
            if (lms[0]) { ctx.save(); ctx.font = '500 11px system-ui,sans-serif'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2.5; ctx.strokeText(label, lms[0].x * canvas.width + 6, lms[0].y * canvas.height + 4); ctx.fillStyle = dotColor; ctx.fillText(label, lms[0].x * canvas.width + 6, lms[0].y * canvas.height + 4); ctx.restore() }
        }

        function onResults(results) {
            frameCount++;
            const now = performance.now();
            if (now - lastTime >= 1000) { document.getElementById('fpsLabel').textContent = `${frameCount} fps`; frameCount = 0; lastTime = now }
            canvas.width = results.image.width; canvas.height = results.image.height;
            ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(results.image, 0, 0);
            const face = results.faceLandmarks, rhRaw = results.rightHandLandmarks, lhRaw = results.leftHandLandmarks, pose = results.poseLandmarks;
            const rh = validHand(rhRaw) ? rhRaw : null, lh = validHand(lhRaw) ? lhRaw : null;
            const fD = !!(face && face.length > 0), rD = !!rh, lD = !!lh, pD = !!(pose && pose.length > 0);
            if (fD) drawFace(face);
            if (rD) drawHand(rh, 'rgba(248,113,113,0.7)', '#f87171', '#fca5a5', 'Kanan');
            if (lD) drawHand(lh, 'rgba(251,191,36,0.7)', '#fbbf24', '#fde68a', 'Kiri');
            if (pD) {
                drawLines(pose, POSE_CONN, 'rgba(52,211,153,0.5)', 2);
                ctx.fillStyle = '#34d399';
                for (let i = 0; i <= 24; i++) { const lm = pose[i]; if (!lm || lm.visibility < 0.3) continue; ctx.beginPath(); ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 3, 0, Math.PI * 2); ctx.fill() }
                document.getElementById('lNose').textContent = fmt(pose[0]);
                document.getElementById('lShoulderL').textContent = fmt(pose[11]);
                document.getElementById('lShoulderR').textContent = fmt(pose[12]);
                document.getElementById('lElbowL').textContent = fmt(pose[13]);
                document.getElementById('lElbowR').textContent = fmt(pose[14]);
                document.getElementById('lWristL').textContent = fmt(pose[15]);
                document.getElementById('lWristR').textContent = fmt(pose[16]);
            }
            processGestures(rh, lh, fD ? face : null, pD ? pose : null);
            updateOrientationUI(rh, lh); updateFingers(rh, 'right'); updateFingers(lh, 'left');
            setDotIndicator('faceInd', fD); setDotIndicator('rightHandInd', rD); setDotIndicator('leftHandInd', lD); setDotIndicator('poseInd', pD);
            const rhOri = rD ? getPalmOrientation(rh, true) : null, lhOri = lD ? getPalmOrientation(lh, false) : null;
            document.getElementById('faceSub').textContent = fD ? `${face.length} titik` : 'Belum terdeteksi';
            document.getElementById('rightHandSub').textContent = rD ? `21 titik · ${rhOri === 'palm' ? 'telapak' : 'punggung'}` : 'Belum terdeteksi';
            document.getElementById('leftHandSub').textContent = lD ? `21 titik · ${lhOri === 'palm' ? 'telapak' : 'punggung'}` : 'Belum terdeteksi';
            document.getElementById('poseSub').textContent = pD ? '33 titik' : 'Belum terdeteksi';
        }

        async function initHolistic() {
            holistic = new Holistic({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${f}` });
            holistic.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false, refineFaceLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
            holistic.onResults(onResults);
            await holistic.initialize();
            document.getElementById('loadingOverlay').style.display = 'none';
            document.getElementById('startBtn').disabled = false;
        }
        async function startCamera() {
            if (running) return; running = true;
            document.getElementById('startBtn').disabled = true; document.getElementById('stopBtn').disabled = false;
            try {
                camera = new Camera(video, { onFrame: async () => { if (running && holistic) await holistic.send({ image: video }) }, width: 640, height: 480 });
                await camera.start();
            } catch (e) { running = false; document.getElementById('startBtn').disabled = false; document.getElementById('stopBtn').disabled = true }
        }
        function stopCamera() {
            if (!running) return; running = false; if (camera) camera.stop();
            document.getElementById('startBtn').disabled = false; document.getElementById('stopBtn').disabled = true;
            if (tts) tts.cancel();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            updateFingers(null, 'right'); updateFingers(null, 'left'); updateOrientationUI(null, null);
            ['rightHandInd', 'leftHandInd', 'faceInd', 'poseInd'].forEach(id => setDotIndicator(id, false));
            ['rightHandSub', 'leftHandSub', 'faceSub', 'poseSub'].forEach(id => document.getElementById(id).textContent = 'Belum terdeteksi');
            document.getElementById('outputMain').textContent = '—'; document.getElementById('outputDesc').textContent = 'Kamera dimatikan';
        }
        document.getElementById('startBtn').addEventListener('click', startCamera);
        document.getElementById('stopBtn').addEventListener('click', stopCamera);
        initHolistic()
            .then(() => refreshJSON())
            .catch(e => { document.getElementById('loadingMsg').textContent = 'Gagal: ' + e.message });

        // ══════════════════════════════════════════════════════════
        //   GESTURE DATABASE (diisi lewat import model_bisindo.json)
        // ══════════════════════════════════════════════════════════
        let gestureDB = {};
        let generatedCode = '';

        function buildDescription(gName, feat) {
            const parts = [];
            if (feat.usesBothHands) parts.push('dua tangan');
            else if (feat.usesRightHand) parts.push('kanan');
            else if (feat.usesLeftHand) parts.push('kiri');
            if (feat.fingers) {
                const fingerNames = ['ibu jari', 'telunjuk', 'tengah', 'manis', 'kelingking'];
                const open = feat.fingers.map((e, i) => e ? fingerNames[i] : null).filter(Boolean);
                if (open.length > 0 && open.length < 5) parts.push(open.join('+'));
                else if (open.length === 5) parts.push('semua jari buka');
                else parts.push('kepalan');
            }
            if (feat.palmOrientation) parts.push(feat.palmOrientation === 'palm' ? 'telapak' : 'punggung');
            if (feat.wristAboveNose) parts.push('di atas hidung');
            if (feat.wristBelowShoulder) parts.push('bawah bahu');
            return parts.join(' · ') || gName;
        }

        function applyGeneratedGestures() {
            const doneSamples = Object.entries(gestureDB).filter(([, g]) => g.features);
            if (doneSamples.length === 0) { showToast('Tidak ada gesture untuk diterapkan', 'error'); return }
            GENERATED_GESTURES = {};
            GENERATED_DESCS = {};
            _gestureFeatures = {};
            for (const [gName, gData] of doneSamples) {
                const feat = gData.features;
                if (!feat) continue;
                _gestureFeatures[gName] = feat;
                GENERATED_DESCS[gName] = buildDescription(gName, feat);
                const hand = feat.usesRightHand ? 'rh' : 'lh';
                const fnBody = buildRuntimeFunction(gName, feat, hand);
                try {
                    GENERATED_GESTURES[gName] = new Function('rh', 'lh', 'face', 'pose', 'validHand', 'extended', 'getPalmOrientation', 'wristAboveNose', 'wristBelowShoulder', 'thumbPinkyDist', fnBody);
                    const orig = GENERATED_GESTURES[gName];
                    GENERATED_GESTURES[gName] = (rh, lh, face, pose) => orig(rh, lh, face, pose, validHand, extended, getPalmOrientation, wristAboveNose, wristBelowShoulder, thumbPinkyDist);
                } catch (e) { console.warn('Failed to compile gesture', gName, e) }
            }
            renderGeneratedGestureCards();
            showToast(`${Object.keys(GENERATED_GESTURES).length} gesture diterapkan ke detektor!`, 'success');
        }

        function buildRuntimeFunction(gName, feat, hand) {
            const lines = [];
            if (feat.usesBothHands) {
                lines.push(`if (!validHand(rh) || !validHand(lh)) return false;`);
                if (feat.fingers) {
                    const checks = feat.fingers.map((ext, i) => { const fn = `extended(rh, ${i})`; return ext ? fn : `!${fn}`; });
                    lines.push(`if (!(${checks.join(' && ')})) return false;`);
                }
                if (feat.palmOrientation) {
                    const expected = feat.palmOrientation === 'palm' ? 'palm' : 'back';
                    lines.push(`if (getPalmOrientation(rh, true) !== '${expected}') return false;`);
                }
                if (feat.thumbPinkyDist != null) {
                    if (feat.thumbPinkyDist < 0.12) lines.push(`if (thumbPinkyDist(rh) >= 0.15) return false;`);
                    else if (feat.thumbPinkyDist > 0.25) lines.push(`if (thumbPinkyDist(rh) <= 0.10) return false;`);
                }
                if (feat.lh_fingers) {
                    const checks = feat.lh_fingers.map((ext, i) => { const fn = `extended(lh, ${i})`; return ext ? fn : `!${fn}`; });
                    lines.push(`if (!(${checks.join(' && ')})) return false;`);
                }
                if (feat.lh_palmOrientation) {
                    const expected = feat.lh_palmOrientation === 'palm' ? 'palm' : 'back';
                    lines.push(`if (getPalmOrientation(lh, false) !== '${expected}') return false;`);
                }
                if (feat.lh_thumbPinkyDist != null) {
                    if (feat.lh_thumbPinkyDist < 0.12) lines.push(`if (thumbPinkyDist(lh) >= 0.15) return false;`);
                    else if (feat.lh_thumbPinkyDist > 0.25) lines.push(`if (thumbPinkyDist(lh) <= 0.10) return false;`);
                }
            } else {
                lines.push(`if (!validHand(${hand})) return false;`);
                if (feat.fingers) {
                    const checks = feat.fingers.map((ext, i) => { const fn = `extended(${hand}, ${i})`; return ext ? fn : `!${fn}`; });
                    lines.push(`if (!(${checks.join(' && ')})) return false;`);
                }
                if (feat.palmOrientation) {
                    const expected = feat.palmOrientation === 'palm' ? 'palm' : 'back';
                    lines.push(`if (getPalmOrientation(${hand}, ${feat.usesRightHand}) !== '${expected}') return false;`);
                }
                if (feat.thumbPinkyDist != null) {
                    if (feat.thumbPinkyDist < 0.12) lines.push(`if (thumbPinkyDist(${hand}) >= 0.15) return false;`);
                    else if (feat.thumbPinkyDist > 0.25) lines.push(`if (thumbPinkyDist(${hand}) <= 0.10) return false;`);
                }
            }
            if (feat.usesPose) {
                lines.push(`if (!pose) return false;`);
                if (feat.wristAboveNose === true) {
                    const s = feat.usesRightHand ? 'right' : 'left';
                    lines.push(`if (!wristAboveNose(pose, '${s}')) return false;`);
                }
                if (feat.wristBelowShoulder === true) {
                    const s = feat.usesRightHand ? 'right' : 'left';
                    lines.push(`if (!wristBelowShoulder(pose, '${s}')) return false;`);
                }
            }
            lines.push(`return true;`);
            return lines.join('\n');
        }

        function renderGeneratedGestureCards() {
            const section = document.getElementById('generatedSection');
            const grid = document.getElementById('generatedGestureGrid');
            const names = Object.keys(GENERATED_GESTURES);
            if (names.length === 0) { section.style.display = 'none'; return }
            section.style.display = 'block';
            grid.innerHTML = names.map(name => `
    <div class="gesture-card generated-card" id="card-${name}">
      <div class="gesture-card-top">
        <div class="gesture-dot" id="dot-${name}"></div>
        <div class="ginfo">
          <div class="gesture-name">${name} <span id="rankpill-${name}" style="display:none" class="top-rank-pill">#1</span></div>
          <div class="gesture-desc" id="desc-${name}">${GENERATED_DESCS[name] || 'Auto-generated'}</div>
          <div id="simtag-${name}" style="display:none" class="similar-tag"></div>
        </div>
        <div class="gesture-badge" id="badge-${name}">—</div>
      </div>
      <div class="confidence-bar-wrap" id="cbwrap-${name}">
        <div class="confidence-bar conf-low" id="cbar-${name}" style="width:0%"></div>
      </div>
    </div>`).join('');
        }

        async function refreshJSON() {
            try {
                const response = await fetch('model_bisindo.json');
                if (!response.ok) throw new Error(`File tidak ditemukan (${response.status})`);
                const data = await response.json();
                if (data.gestureDB) {
                    for (const [gName, gData] of Object.entries(data.gestureDB)) {
                        if (!gestureDB[gName]) gestureDB[gName] = { samples: [], features: null };
                        if (gData.samples) {
                            for (const s of gData.samples) {
                                if (!gestureDB[gName].samples.find(x => x.filename === s.filename)) {
                                    gestureDB[gName].samples.push(s);
                                }
                            }
                        }
                        if (gData.features) gestureDB[gName].features = gData.features;
                    }
                }
                if (data.generatedCode) generatedCode = data.generatedCode;
                applyGeneratedGestures();
                showToast(`Import berhasil: ${Object.keys(data.gestureDB || {}).length} gesture dimuat`, 'success');
            } catch (e) {
                showToast('Gagal memuat model_bisindo.json: ' + e.message, 'error');
            }
        }
    </script>
