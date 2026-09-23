// Native decoder for Aion `0x81` encrypted HTML (dialogs).
// Reversed from AIONdisasm 1.6.5 `ProcessHTMLBlob` (M. Soltys).
//
// Layout: `[0x81][payload...]` where `payload = E[1..]` has the same length
// as `gold.length + 1`. After XOR-decrypt, `payload[0]` must be `0x81`
// (marker) and `payload[1..]` is the UTF-16LE document (incl. BOM).
//
// Key: lowercase-insensitive stem of the file name — basename without
// directory and without the last extension (`quest_q1001.html` → `quest_q1001`).
// Only `basename` enters the key; the directory path is ignored.
//
// Hash: `t_i = (stem[i] & 0xF) + i` (`& 0xF` kills the ASCII case bit,
// hence case-insensitive); `edx = Σ t_i`, `ebx = XOR t_i` (uint32).
//
// Stream (uint32 wrap): per payload byte
// `edx = (edx + 0x1D) ^ ebx; ebx += 3; plain = cipher ^ (edx & 0xFF)`.
export function decodeAionEncryptedHtml(input: Buffer, fileName: string): Buffer {
	if (input.length === 0 || input[0] !== 0x81) {
		throw new Error('not encrypted html');
	}
	const base = fileName.split('/').pop() as string;
	const short = base.split('\\').pop() as string;
	const dot = short.lastIndexOf('.');
	const stem = dot >= 0 ? short.slice(0, dot) : short;
	let edx = 0;
	let ebx = 0;
	for (let i = 0; i < stem.length; i += 1) {
		const t = ((stem.charCodeAt(i) & 0xf) + i) >>> 0;
		edx = (edx + t) >>> 0;
		ebx = (ebx ^ t) >>> 0;
	}
	const payload = input.subarray(1);
	const decrypted = Buffer.alloc(payload.length);
	for (let j = 0; j < payload.length; j += 1) {
		edx = (edx + 0x1d) >>> 0;
		edx = (edx ^ ebx) >>> 0;
		ebx = (ebx + 3) >>> 0;
		decrypted[j] = payload[j] ^ (edx & 0xff);
	}
	if (decrypted[0] !== 0x81) {
		throw new Error('html decrypt failed');
	}
	return decrypted.subarray(1);
}
