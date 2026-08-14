// Generates valid high-definition Letterboxd-styled extension icons (pure Node.js)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createLetterboxdDiceIcon(size) {
    const width = size;
    const height = size;
    const buffer = Buffer.alloc(width * height * 4); // RGBA

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

    // Outer dark charcoal rounded square (#14181c)
    const radius = width * 0.46;
    const cornerRadius = width * 0.22;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = Math.abs(x - cx);
            const dy = Math.abs(y - cy);
            
            let inside = false;
            if (dx <= radius - cornerRadius && dy <= radius) inside = true;
            else if (dy <= radius - cornerRadius && dx <= radius) inside = true;
            else {
                const cornerDx = dx - (radius - cornerRadius);
                const cornerDy = dy - (radius - cornerRadius);
                if (cornerDx * cornerDx + cornerDy * cornerDy <= cornerRadius * cornerRadius) {
                    inside = true;
                }
            }

            if (inside) {
                setPixel(x, y, 20, 24, 28, 255); // #14181c
            }
        }
    }

    // Inner dice face container (#202830) with border (#445566)
    const diceW = width * 0.70;
    const diceH = height * 0.70;
    const diceX = (width - diceW) / 2;
    const diceY = (height - diceH) / 2;
    const diceR = diceW * 0.18;

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
                const isBorder = (y <= Math.floor(diceY) + 1 || y >= Math.ceil(diceY + diceH) - 1 ||
                                  x <= Math.floor(diceX) + 1 || x >= Math.ceil(diceX + diceW) - 1);
                if (isBorder && size >= 32) {
                    setPixel(x, y, 68, 85, 102, 255); // #445566
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
    // Official PNG Signature: 89 50 4E 47 0D 0A 1A 0A
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR Chunk
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8);  // Bit depth: 8
    ihdr.writeUInt8(6, 9);  // Color type: RGBA (6)
    ihdr.writeUInt8(0, 10); // Compression method: deflate
    ihdr.writeUInt8(0, 11); // Filter method: standard
    ihdr.writeUInt8(0, 12); // Interlace method: none

    const ihdrChunk = createChunk('IHDR', ihdr);

    // IDAT Chunk (Scanlines with filter byte 0)
    const scanlineLength = width * 4 + 1;
    const rawData = Buffer.alloc(height * scanlineLength);

    for (let y = 0; y < height; y++) {
        const lineOffset = y * scanlineLength;
        rawData[lineOffset] = 0; // Filter: None
        rgbaBuffer.copy(rawData, lineOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawData);
    const idatChunk = createChunk('IDAT', compressed);

    // IEND Chunk
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
    chunk.writeUInt32BE(crc >>> 0, 8 + len);
    return chunk;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        if (c & 1) c = 0xedb88320 ^ (c >>> 1);
        else c = c >>> 1;
    }
    crcTable[n] = c >>> 0;
}

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

[16, 32, 48, 128].forEach(size => {
    const png = createLetterboxdDiceIcon(size);
    const filePath = path.join(iconsDir, `icon${size}.png`);
    fs.writeFileSync(filePath, png);
    console.log(`Generated valid PNG: ${filePath} (${size}x${size}, ${png.length} bytes)`);
});
