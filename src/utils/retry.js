const logger = require('./logger');

/**
 * Marks an error as permanent so withRetry will not retry it.
 *
 * A retry is only worth its wall-clock cost when re-running the operation could
 * plausibly produce a different result. Errors describing a permanent condition
 * - a malformed URL, a DOM element nothing will recreate, an unsupported
 * protocol - would burn the entire backoff schedule to reach the same outcome.
 * Observed cost before this existed: three identical "Could not find clickable
 * element" warnings ~8s apart for every failing attachment, and unit tests
 * taking exactly 3s (1s + 2s of backoff) to fail on a bad URL.
 *
 * @param {Error} error - The error to mark
 * @param {string} reason - Optional human-readable reason for the log
 * @returns {Error} The same error, marked
 */
function permanent(error, reason) {
    error.permanent = true;
    if (reason) error.permanentReason = reason;
    return error;
}

/**
 * True when an error should stop the retry loop immediately.
 * @param {Error} error - Error thrown by the retried function
 * @returns {boolean}
 */
function isPermanent(error) {
    return Boolean(error && error.permanent);
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} options.initialDelayMs - Initial delay in milliseconds (default: 500)
 * @param {number} options.maxDelayMs - Maximum delay in milliseconds (default: 5000)
 * @param {number} options.backoffMultiplier - Backoff multiplier (default: 2)
 * @param {string} options.operationName - Name of operation for logging (default: 'Operation')
 * @param {boolean} options.silent - Suppress retry logging (default: false)
 * @param {number} options.maxElapsedMs - Give up once this much wall-clock has
 *   passed, instead of after a fixed number of attempts (default: no limit)
 * @returns {Promise<any>} Result of the function
 * @throws {Error} If all attempts fail, or immediately if the error is permanent
 */
async function withRetry(fn, options = {}) {
    const {
        maxAttempts = 3,
        initialDelayMs = 500,
        maxDelayMs = 5000,
        backoffMultiplier = 2,
        operationName = 'Operation',
        silent = false,
        maxElapsedMs = Infinity
    } = options;

    const startedAt = Date.now();
    let lastError;
    let delayMs = initialDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Nothing about the situation will change on a second attempt, so
            // stop now instead of paying the backoff to reach the same outcome.
            if (isPermanent(error)) {
                if (!silent) {
                    logger.debug(
                        `${operationName} failed permanently ` +
                        `(${error.permanentReason || 'no reason given'}), not retrying.`
                    );
                }
                throw error;
            }

            if (attempt === maxAttempts) {
                if (!silent) {
                    logger.error(`${operationName} failed after ${maxAttempts} attempts:`, error);
                }
                throw error;
            }

            // An attempt is not free. The operation may be a 15 second round trip
            // to a cloud service, so a count of attempts says nothing about how
            // long the work takes - and on a real notebook, minutes per file is
            // the difference between an export that finishes and one that looks
            // hung. The remaining time is checked before paying the backoff: an
            // attempt that cannot even start in time is not worth starting.
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs + delayMs >= maxElapsedMs) {
                if (!silent) {
                    logger.warn(
                        `${operationName} gave up on attempt ${attempt} of ${maxAttempts} ` +
                        `after ${Math.round(elapsedMs / 1000)}s: no room left in the ` +
                        `${Math.round(maxElapsedMs / 1000)}s budget for another try.`
                    );
                }
                throw error;
            }

            if (!silent) {
                logger.warn(`${operationName} failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
                logger.info(`Will wait ${delayMs / 1000} seconds to retry`);
                logger.debug(`  Retrying in ${delayMs}ms...`);
            }

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delayMs));

            // Exponential backoff with max cap
            delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
        }
    }

    // Unreachable: the loop either returns, throws (permanent or exhausted), or
    // falls through only if maxAttempts is 0 or negative. Kept as a guard so a
    // misconfigured call still rejects rather than resolving with undefined.
    throw lastError || new Error(`${operationName} was not attempted`);
}

module.exports = { withRetry, permanent, isPermanent };
