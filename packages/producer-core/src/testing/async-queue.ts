/** Values pushed by one side and awaited, in order, by the other. */
class AsyncQueue<T> {
	private values: T[] = [];
	private waiters: ((value: T) => void)[] = [];

	push(value: T): void {
		const waiter = this.waiters.shift();

		if (waiter) {
			waiter(value);

			return;
		}

		this.values.push(value);
	}

	/**
	 * The next value, waiting for it when none is queued.
	 *
	 * @returns The oldest value not yet taken.
	 */
	next(): Promise<T> {
		const value = this.values.shift();

		if (value !== undefined) {
			return Promise.resolve(value);
		}

		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Every value queued and not yet taken. */
	get pending(): readonly T[] {
		return this.values;
	}
}

export default AsyncQueue;
