const { withRetry, permanent, isPermanent } = require('../src/utils/retry');

describe('permanent errors', () => {
    it('marks an error and records a reason', () => {
        const err = permanent(new Error('nope'), 'because reasons');
        expect(isPermanent(err)).toBe(true);
        expect(err.permanentReason).toBe('because reasons');
    });

    it('does not mark a plain error', () => {
        expect(isPermanent(new Error('nope'))).toBe(false);
        expect(isPermanent(undefined)).toBe(false);
    });

    // A retry is only worth its cost if a second attempt could differ. A missing
    // DOM element, a malformed URL or an unsupported protocol cannot change, and
    // a real run showed three identical warnings ~8s apart per attachment.
    it('stops immediately instead of burning the backoff', async () => {
        const fn = jest.fn().mockRejectedValue(permanent(new Error('gone'), 'element missing'));
        const started = Date.now();

        await expect(withRetry(fn, { maxAttempts: 5, initialDelayMs: 1000, silent: true }))
            .rejects.toThrow('gone');

        expect(fn).toHaveBeenCalledTimes(1);
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('still retries ordinary errors the full number of times', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('transient'));

        await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, silent: true }))
            .rejects.toThrow('transient');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries when an earlier attempt fails permanently but a later one would not', async () => {
        // Guards against a permanent error poisoning the whole loop: the flag is
        // per-throw, and a fresh error each attempt is judged on its own merits.
        const fn = jest.fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValue('ok');

        await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, silent: true }))
            .resolves.toBe('ok');
    });
});

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

    // The trailing `throw lastError` was unreachable, so a misconfigured
    // maxAttempts would have resolved with undefined instead of rejecting.
    it('rejects rather than resolving when maxAttempts is zero', async () => {
        const fn = jest.fn();
        await expect(withRetry(fn, { maxAttempts: 0, silent: true })).rejects.toThrow(/was not attempted/);
        expect(fn).not.toHaveBeenCalled();
    });

    it('rejects rather than resolving for a negative maxAttempts', async () => {
        await expect(withRetry(() => 'never', { maxAttempts: -1, silent: true })).rejects.toThrow(/was not attempted/);
    });

    it('defaults to a single attempt when maxAttempts is 1', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('once'));
        await expect(withRetry(fn, { initialDelayMs: 1, silent: true })).rejects.toThrow('once');
        expect(fn).toHaveBeenCalledTimes(3); // default maxAttempts is 3
    });
});
