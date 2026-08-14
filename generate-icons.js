// Generates Letterboxd-styled extension icons (pure Node.js)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createLetterboxdDiceIcon(size) {
    const width = size;
    const height = size;
    const buffer = Buffer.alloc(width * height * 4);

    function setPixel(x, y, r, g, b, a = 255) {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const idx = (y * width + x) * 4;
        buffer[idx] = r;
        buffer[idx + 1] = g;
        buffer[idx + 2] = b;
        buffer[idx + 3] = a;
    }

    const cx = width / 2;
    const cy = height / 2;
    const radius = width * 0.46;
    const cornerRadius = width * 0.20;

    // Dark charcoal Letterboxd background #14181c with subtle border
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = Math.abs(x - cx);
            const dy = Math.abs(y - cy);
            const boxHalf = radius;
            
            let inside = false;
            if (dx <= boxHalf - cornerRadius && dy <= boxHalf) inside = true;
            else if (dy <= boxHalf - cornerRadius && dx <= boxHalf) inside = true;
            else {
                const cornerDx = dx - (boxHalf - cornerRadius);
                const cornerDy = dy - (boxHalf - cornerRadius);
                if (cornerDx * cornerDx + cornerDy * cornerDy <= cornerRadius * cornerRadius) {
                    inside = true;
                }
            }

            if (inside) {
                setPixel(x, y, 20, 24, 28, 255); // #14181c
            }
        }
    }

    // Inner dice face: slightly lighter #202830
    const diceW = width * 0.72;
    const diceH = height * 0.72;
    const diceX = (width - diceW) / 2;
    const diceY = (height - diceH) / 2;
    const diceR = diceW * 0.16;

    for (let y = Math.floor(diceY); y <= Math.ceil(diceY + diceH); y++) {
        for (let x = Math.floor(diceX); x <= Math.ceil(diceX + diceW); x++) {
            const dx = Math.abs(x - (diceX + diceW / 2));
            const dy = Math.abs(y - (diceY + diceH / 2));
            const hw = diceW / 2;
            const hh = diceH / 2;

            let insideDice = false;
            if (dx <= hw - diceR && dy <= hh) insideDice = true;
            else if (dy <= hh - diceR && dx <= hw) insideDice = true;
            else {
                const cdx = dx - (hw - diceR);
                const cdy = dy - (hh - diceR);
                if (cdx * cdx + cdy * cdy <= diceR * diceR) {
                    insideDice = true;
                }
            }

            if (insideDice) {
                // Border pixel check
                const isBorder = (y === Math.floor(diceY) || y === Math.ceil(diceY + diceH) || x === Math.floor(diceX) || x === Math.ceil(diceX + diceW));
                if (isBorder && size >= 48) {
                    setPixel(x, y, 48, 56, 64, 255);
                } else {
                    setPixel(x, y, 32, 40, 48, 255); // #202830
                }
            }
        }
    }

    // 3 Letterboxd signature colored pips (Orange #ff8000, Green #00e054, Cyan #40bcf4)
    const pipRadius = Math.max(1.2, width * 0.08);
    const pips = [
        { x: diceX + diceW * 0.28, y: diceY + diceH * 0.28, r: 255, g: 128, b: 0 },  // Orange
        { x: diceX + diceW * 0.50, y: diceY + diceH * 0.50, r: 0,   g: 224, b: 84 }, // Green
        { x: diceX + diceW * 0.72, y: diceY + diceH * 0.72, r: 64,  g: 188, b: 244 } // Cyan
    ];

    pips.forEach(p => {
        for (let y = Math.floor(p.y - pipRadius - 1); y <= Math.ceil(p.y + pipRadius + 1); y++) {
            for (let x = Math.floor(p.x - pipRadius - 1); x <= Math.ceil(p.x + pipRadius + 1); x++) {
                const dist = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
                if (dist <= pipRadius) {
                    setPixel(x, y, p.r, p.g, p.b, 255);
                }
            }
        }
    });

    return encodePNG(width, height, buffer);
}

function encodePNG(width, height, rgbaBuffer) {
    const signature = Buffer.from([137, 80, 78, 79, 13, 10, 26, 10]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(6, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);

    const ihdrChunk = createChunk('IHDR', ihdr);

    const scanlineLength = width * 4 + 1;
    const rawData = Buffer.alloc(height * scanlineLength);

    for (let y = 0; y < height; y++) {
        const lineOffset = y * scanlineLength;
        rawData[lineOffset] = 0;
        rgbaBuffer.copy(rawData, lineOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawData);
    const idatChunk = createChunk('IDAT', compressed);
    const iendChunk = createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
    const len = data.length;
    const chunk = Buffer.alloc(12 + len);
    chunk.writeUInt32BE(len, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);

    const crc = crc32(chunk.subarray(4, 8 + len));
    chunk.writeInt32BE(crc, 8 + len);
    return chunk;
}

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        if (c & 1) c = 0xedb88320 ^ (c >>> 1);
        else c = c >>> 1;
    }
    crcTable[n] = c;
}

function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return crc ^ -1;
}

const iconsDir = path.join(__dirname, 'icons');
[16, 48, 128].forEach(size => {
    const png = createLetterboxdDiceIcon(size);
    const filePath = path.join(iconsDir, `icon${size}.png`);
    fs.writeFileSync(filePath, png);
    console.log(`Generated ${filePath} (${size}x${size})`);
});
