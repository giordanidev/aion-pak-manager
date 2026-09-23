// Ported from Gibbed.Aion (zlib) + serialization aligned to AIONdisasm.
// Binary XML (`0x80`): packed string table (UTF-16LE) + packed node tree.
interface BxmlNode {
	name: string;
	value: string | null;
	attributes: Array<[string, string]>;
	children: BxmlNode[];
}

interface Cursor {
	i: number;
}

function readPackedS32(buf: Buffer, pos: Cursor): number {
	let current = buf[pos.i++];
	let value = 0;
	let shift = 0;
	while (current >= 0x80) {
		value |= (current & 0x7f) << shift;
		shift += 7;
		current = buf[pos.i++];
	}
	return value | (current << shift);
}

function getString(table: Buffer, index: number): string {
	if (index === 0) return '';
	const start = index * 2;
	let end = table.length;
	for (let i = start; i + 2 <= end; i += 2) {
		if (table[i] === 0 && table[i + 1] === 0) {
			end = i;
			break;
		}
	}
	return table.toString('utf16le', start, end);
}

function readNode(buf: Buffer, pos: Cursor, table: Buffer): BxmlNode {
	const name = getString(table, readPackedS32(buf, pos));
	const flags = buf[pos.i++];
	let value: string | null = null;
	const attributes: Array<[string, string]> = [];
	const children: BxmlNode[] = [];
	if ((flags & 1) === 1) value = getString(table, readPackedS32(buf, pos));
	if ((flags & 2) === 2) {
		const count = readPackedS32(buf, pos);
		for (let i = 0; i < count; i++) {
			const key = getString(table, readPackedS32(buf, pos));
			const val = getString(table, readPackedS32(buf, pos));
			attributes.push([key, val]);
		}
	}
	if ((flags & 4) === 4) {
		const count = readPackedS32(buf, pos);
		for (let i = 0; i < count; i++) children.push(readNode(buf, pos, table));
	}
	return { name, value, attributes, children };
}

function escapeXml(s: string): string {
	let out = '';
	for (const ch of s) {
		const c = ch.codePointAt(0) as number;
		if (c === 38) out += '&amp;';
		else if (c === 60) out += '&lt;';
		else if (c === 62) out += '&gt;';
		else if (c === 39) out += '&apos;';
		else if (c === 34) out += '&quot;';
		else if (c === 13) out += '&#xD;';
		else if (c === 10) out += '&#xA;';
		else if (c === 9) out += '&#x9;';
		else if (c === 11) out += '&#xB;';
		else if (c === 0) out += '&#x0;';
		else out += ch;
	}
	return out;
}

function writeNode(node: BxmlNode, indent: number): string {
	const pad = '\t'.repeat(indent);
	let attrs = '';
	for (const [k, v] of node.attributes) {
		attrs += ` ${k}="${escapeXml(v)}"`;
	}
	const hasKids = node.children.length > 0;
	const hasVal = node.value != null && node.value !== '';
	if (!hasKids && !hasVal) {
		return `${pad}<${node.name}${attrs}>\n${pad}</${node.name}>\n`;
	}
	if (!hasKids && hasVal) {
		return `${pad}<${node.name}${attrs}>${escapeXml(node.value as string)}</${node.name}>\n`;
	}
	let out = `${pad}<${node.name}${attrs}>\n`;
	for (const c of node.children) out += writeNode(c, indent + 1);
	if (hasVal && node.value !== '') out += `${pad}\t${escapeXml(node.value as string)}\n`;
	else if (hasVal) out += `${pad}\t\n`;
	out += `${pad}</${node.name}>\n`;
	return out;
}

export function decodeAionBinaryXml(input: Buffer): string {
	if (input.length === 0 || input[0] !== 0x80) throw new Error('not bxml');
	const pos: Cursor = { i: 1 };
	const size = readPackedS32(input, pos);
	const table = input.subarray(pos.i, pos.i + size);
	pos.i += size;
	const root = readNode(input, pos, table);
	return `<?xml version="1.0" encoding="UTF-8" ?>\n` + writeNode(root, 0);
}
