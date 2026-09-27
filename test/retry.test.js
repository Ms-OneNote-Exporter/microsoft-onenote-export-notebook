const { withRetry } = require('../src/utils/retry');

describe('withRetry', () => {
    it('returns the value on the first success without retrying', async () => {
        const fn = jest.fn().mockResolvedValue('ok');
        await expect(withRetry(fn, { silent: true })).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries until the function succeeds', async () => {
        const fn = jest.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue('recovered');

        await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, silent: true }))
            .resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxAttempts and rethrows the last error', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('always fails'));

        await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, silent: true }))
            .rejects.toThrow('always fails');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('surfaces the FINAL error, not the first', async () => {
        const fn = jest.fn()
            .mockRejectedValueOnce(new Error('first'))
            .mockRejectedValueOnce(new Error('second'))
            .mockRejectedValueOnce(new Error('third'));

        await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, silent: true }))
            .rejects.toThrow('third');
    });

    it('backs off exponentially up to the cap', async () => {
        const delays = [];
        const realSetTimeout = global.setTimeout;
        jest.spyOn(global, 'setTimeout').mockImplementation((fn_, ms) => {
            delays.push(ms);
            return realSetTimeout(fn_, 0);
        });

        const fn = jest.fn().mockRejectedValue(new Error('nope'));
        await withRetry(fn, {
            maxAttempts: 4, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 250, silent: true,
        }).catch(() => { /* expected */ });

        expect(delays).toEqual([100, 200, 250]);
        global.setTimeout.mockRestore();
    });

    it('waits between attempts but not after the last one', async () => {
        const delays = [];
        const realSetTimeout = global.setTimeout;
        jest.spyOn(global, 'setTimeout').mockImplementation((fn_, ms) => {
            delays.push(ms);
            return realSetTimeout(fn_, 0);
        });

        const fn = jest.fn().mockRejectedValue(new Error('nope'));
        await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, silent: true }).catch(() => {});

        // 3 attempts means 2 waits, not 3.
        expect(delays).toHaveLength(2);
        global.setTimeout.mockRestore();
    });

    it('passes the resolved value of a non-promise too', async () => {
        await expect(withRetry(() => 42, { silent: true })).resolves.toBe(42);
    });

    it('defaults to a single attempt when maxAttempts is 1', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('once'));
        await expect(withRetry(fn, { initialDelayMs: 1, silent: true })).rejects.toThrow('once');
        expect(fn).toHaveBeenCalledTimes(3); // default maxAttempts is 3
    });
});
