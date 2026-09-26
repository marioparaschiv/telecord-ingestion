import { describe, expect, it } from 'vitest';

import UnackedBuffer from '../src/unacked-buffer';

function frame(byte: number) {
	return new Uint8Array([byte]);
}

describe('UnackedBuffer', () => {
	it('keeps frames in the order they were produced', () => {
		const buffer = new UnackedBuffer(3);

		buffer.push('a', frame(1));
		buffer.push('b', frame(2));
		buffer.delete('a');
		buffer.push('c', frame(3));

		expect(buffer.first()).toEqual(['b', frame(2)]);
		expect(buffer.size).toBe(2);
	});

	it('drops and counts the oldest frame on overflow', () => {
		const buffer = new UnackedBuffer(2);

		buffer.push('a', frame(1));
		buffer.push('b', frame(2));

		expect(buffer.push('c', frame(3))).toBe('a');
		expect(buffer.dropped).toBe(1);
		expect(buffer.has('a')).toBe(false);
		expect(buffer.first()).toEqual(['b', frame(2)]);
	});
});
