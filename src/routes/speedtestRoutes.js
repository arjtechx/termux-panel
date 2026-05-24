const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');

// 1. Função auxiliar para medir a latência (Ping HTTP RTT)
async function measurePing() {
    const urls = ['https://1.1.1.1', 'https://www.google.com'];
    const samples = [];
    let attempts = 0;
    let fails = 0;

    for (const url of urls) {
        for (let i = 0; i < 3; i++) {
            attempts++;
            const start = Date.now();
            try {
                await new Promise((resolve, reject) => {
                    const req = https.get(url, { timeout: 1500 }, (res) => {
                        res.resume();
                        resolve();
                    });
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('timeout'));
                    });
                });
                const rtt = Date.now() - start;
                samples.push(rtt);
            } catch (_) {
                fails++;
            }
        }
    }

    if (!samples.length) {
        return { ping: 999, jitter: 0, packetLoss: 100, samples: [] };
    }

    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    let jitter = 0;
    if (samples.length > 1) {
        const diffs = [];
        for (let i = 1; i < samples.length; i++) diffs.push(Math.abs(samples[i] - samples[i - 1]));
        jitter = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    }
    const packetLoss = attempts > 0 ? Math.max(0, Math.min(100, Math.round((fails / attempts) * 100))) : 0;
    return {
        ping: Math.round(avg),
        jitter: Math.round(jitter),
        packetLoss,
        samples
    };
}

// Função auxiliar para lidar com redirects no GET
function getWithRedirects(url, options, callback, onReqCreated, redirectCount = 0) {
    if (redirectCount > 5) {
        throw new Error('Too many redirects');
    }
    
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'http:' ? require('http') : require('https');
    
    const req = lib.get(url, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // Consome a resposta do redirect
            const newUrl = new URL(res.headers.location, url).href;
            return getWithRedirects(newUrl, options, callback, onReqCreated, redirectCount + 1);
        }
        callback(res);
    });

    if (onReqCreated) {
        onReqCreated(req);
    }
}

// 2. Função auxiliar para medir velocidade de Download (Média ponderada em janela de 10 segundos)
function runDownloadTest(onProgress, profile = {}) {
    return new Promise((resolve) => {
        const url = profile.downloadUrl || 'https://proof.ovh.net/files/100Mb.dat';
        const startTime = Date.now();
        const durationLimit = profile.durationLimit || 10000;
        let bytesReceived = 0;
        let isDone = false;
        let currentReq = null;

        const timeoutTimer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                if (currentReq) currentReq.destroy();
                const duration = (Date.now() - startTime) / 1000;
                const speedMbps = duration > 0 ? ((bytesReceived * 8) / (1024 * 1024)) / duration : 0;
                resolve(parseFloat(speedMbps.toFixed(2)));
            }
        }, durationLimit);

        getWithRedirects(url, {}, (res) => {
            const contentLength = parseInt(res.headers['content-length']) || 100000000;

            res.on('data', (chunk) => {
                if (isDone) return;
                bytesReceived += chunk.length;

                const elapsed = (Date.now() - startTime) / 1000;
                const speedMbps = elapsed > 0 ? ((bytesReceived * 8) / (1024 * 1024)) / elapsed : 0;
                
                // Progresso baseado no tempo decorrido ou nos bytes recebidos (o que for maior)
                const percent = Math.min(100, Math.max(
                    Math.round((bytesReceived / contentLength) * 100),
                    Math.round((elapsed / (durationLimit / 1000)) * 100)
                ));

                onProgress({
                    percent,
                    speedMbps: parseFloat(speedMbps.toFixed(2))
                });
            });

            res.on('end', () => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(timeoutTimer);
                    const duration = (Date.now() - startTime) / 1000;
                    const speedMbps = duration > 0 ? ((bytesReceived * 8) / (1024 * 1024)) / duration : 0;
                    resolve(parseFloat(speedMbps.toFixed(2)));
                }
            });
        }, (req) => {
            currentReq = req;
            req.on('error', () => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(timeoutTimer);
                    const duration = (Date.now() - startTime) / 1000;
                    const speedMbps = bytesReceived > 0 && duration > 0 ? ((bytesReceived * 8) / (1024 * 1024)) / duration : 0;
                    resolve(parseFloat(speedMbps.toFixed(2)));
                }
            });
        });
    });
}

// 3. Função auxiliar para medir velocidade de Upload (Loop de escrita em janela de 10 segundos)
function runUploadTest(onProgress, profile = {}) {
    return new Promise((resolve) => {
        const url = 'https://speed.cloudflare.com/__up';
        const targetUploadSize = profile.uploadSize || (100 * 1024 * 1024);
        const bufferChunkSize = 2 * 1024 * 1024; // Buffer físico de 2MB em memória (baixo consumo)
        const buffer = crypto.randomBytes(bufferChunkSize);
        const startTime = Date.now();
        const durationLimit = profile.durationLimit || 10000;
        let bytesWritten = 0;
        let isDone = false;

        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Length': targetUploadSize,
                'Content-Type': 'application/octet-stream'
            }
        };

        const timeoutTimer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                req.destroy();
                const duration = (Date.now() - startTime) / 1000;
                const speedMbps = duration > 0 ? ((bytesWritten * 8) / (1024 * 1024)) / duration : 0;
                resolve(parseFloat(speedMbps.toFixed(2)));
            }
        }, durationLimit);

        const req = https.request(options, (res) => {
            res.on('data', () => {}); // Consome resposta
            res.on('end', () => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(timeoutTimer);
                    const duration = (Date.now() - startTime) / 1000;
                    const speedMbps = duration > 0 ? ((bytesWritten * 8) / (1024 * 1024)) / duration : 0;
                    resolve(parseFloat(speedMbps.toFixed(2)));
                }
            });
        });

        req.on('error', () => {
            if (!isDone) {
                isDone = true;
                clearTimeout(timeoutTimer);
                const duration = (Date.now() - startTime) / 1000;
                const speedMbps = bytesWritten > 0 && duration > 0 ? ((bytesWritten * 8) / (1024 * 1024)) / duration : 0;
                resolve(parseFloat(speedMbps.toFixed(2)));
            }
        });

        // Loop de escrita assíncrono e contínuo
        const sliceSize = 256 * 1024; // Escreve chunks de 256KB para monitoramento suave
        let localOffset = 0;

        function writeChunk() {
            if (isDone) return;

            // Se atingir limite de upload do alvo ou tempo limite, finaliza
            if (bytesWritten >= targetUploadSize) {
                req.end();
                return;
            }

            // Loop circular sob o buffer físico de 2MB
            if (localOffset >= bufferChunkSize) {
                localOffset = 0;
            }

            const chunk = buffer.subarray(localOffset, localOffset + sliceSize);
            req.write(chunk, () => {
                bytesWritten += chunk.length;
                localOffset += chunk.length;

                const elapsed = (Date.now() - startTime) / 1000;
                const speedMbps = elapsed > 0 ? ((bytesWritten * 8) / (1024 * 1024)) / elapsed : 0;
                
                // Progresso baseado no tempo decorrido ou nos bytes gravados (o que for maior)
                const percent = Math.min(100, Math.max(
                    Math.round((bytesWritten / targetUploadSize) * 100),
                    Math.round((elapsed / (durationLimit / 1000)) * 100)
                ));

                onProgress({
                    percent,
                    speedMbps: parseFloat(speedMbps.toFixed(2))
                });

                setImmediate(writeChunk);
            });
        }

        writeChunk();
    });
}

// 4. Rota SSE (Server-Sent Events) para orquestrar o Speedtest
router.get('/speedtest', (req, res) => {
    // Configura cabeçalhos do Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    // Orquestra a execução assíncrona sequencialmente
    (async () => {
        try {
            const mode = String(req.query.mode || 'fast').toLowerCase();
            const profile = mode === 'slow'
                ? {
                    durationLimit: 15000,
                    downloadUrl: 'https://proof.ovh.net/files/1Gb.dat',
                    uploadSize: 180 * 1024 * 1024
                }
                : {
                    durationLimit: 7000,
                    downloadUrl: 'https://proof.ovh.net/files/100Mb.dat',
                    uploadSize: 80 * 1024 * 1024
                };

            // Fase 1: Latência (Ping)
            send({ stage: 'ping', status: 'running' });
            const pingStats = await measurePing();
            send({ stage: 'ping', status: 'done', ...pingStats });

            // Pequeno delay entre fases para estabilizar a rede local
            await new Promise(resolve => setTimeout(resolve, 500));

            // Fase 2: Download
            send({ stage: 'download', status: 'running', percent: 0, speed: 0.0 });
            const downloadSpeed = await runDownloadTest((progress) => {
                send({
                    stage: 'download',
                    status: 'running',
                    percent: progress.percent,
                    speed: progress.speedMbps
                });
            }, profile);
            send({ stage: 'download', status: 'done', speed: downloadSpeed });

            await new Promise(resolve => setTimeout(resolve, 500));

            // Fase 3: Upload
            send({ stage: 'upload', status: 'running', percent: 0, speed: 0.0 });
            const uploadSpeed = await runUploadTest((progress) => {
                send({
                    stage: 'upload',
                    status: 'running',
                    percent: progress.percent,
                    speed: progress.speedMbps
                });
            }, profile);
            send({ stage: 'upload', status: 'done', speed: uploadSpeed });

            // Finalizado
            send({
                stage: 'finished',
                ping: pingStats.ping,
                jitter: pingStats.jitter,
                packetLoss: pingStats.packetLoss,
                download: downloadSpeed,
                upload: uploadSpeed
            });

            res.end();
        } catch (error) {
            send({ stage: 'error', message: error.message });
            res.end();
        }
    })();

    // Se o cliente cancelar/fechar a requisição, limpamos
    req.on('close', () => {
        res.end();
    });
});

module.exports = router;
