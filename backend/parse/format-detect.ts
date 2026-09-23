import { closeSync, openSync, readSync } from 'fs';

export function isUtf16Le(buffer: Buffer): boolean {
	return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
}

export function isEncryptedXml(buffer: Buffer): boolean {
	return buffer.length > 0 && buffer[0] === 0x80;
}

export function isEncryptedHtml(buffer: Buffer): boolean {
	return buffer.length > 0 && buffer[0] === 0x81;
}

function isUtf8Xml(buffer: Buffer): boolean {
	return buffer.length >= 5 && buffer.slice(0, 5).toString('utf8', 0, 5).startsWith('<?xml');
}

export function isPlainXml(buffer: Buffer): boolean {
	if (isUtf8Xml(buffer)) {
		return true;
	}
	if (isUtf16Le(buffer)) {
		return buffer.length >= 12 && buffer.slice(2, 12).toString('utf16le').startsWith('<?xml');
	}
	if (buffer.length >= 4) {
		const startsWithUtf16Tag = buffer[0] === 0x3c && buffer[1] === 0x00 && buffer[2] === 0x3f && buffer[3] === 0x00;
		return startsWithUtf16Tag;
	}
	return false;
}

export function isPlainHtml(buffer: Buffer): boolean {
	const sample = buffer.slice(0, 256);
	const text = sample.toString('utf8').toLowerCase();
	if (text.startsWith('<html') || text.startsWith('<!doctype html') || text.includes('<html') || text.includes('<htmlpages')) {
		return true;
	}
	if (isUtf16Le(buffer)) {
		const utf16text = sample.toString('utf16le').toLowerCase();
		return utf16text.startsWith('\ufeff<?xml')
			|| utf16text.startsWith('<?xml')
			|| utf16text.startsWith('\ufeff<!--')
			|| utf16text.startsWith('<!--')
			|| utf16text.includes('<htmlpages')
			|| utf16text.startsWith('<html')
			|| utf16text.startsWith('<!doctype html')
			|| utf16text.includes('<html');
	}
	return false;
}

export function readPrefix(filePath: string, length = 256): Buffer {
	const fd = openSync(filePath, 'r');
	try {
		const buffer = Buffer.alloc(length);
		const bytesRead = readSync(fd, buffer, 0, length, 0);
		return buffer.slice(0, bytesRead);
	} finally {
		closeSync(fd);
	}
}
