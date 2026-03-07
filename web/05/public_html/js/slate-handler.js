/**
 * Slate Handler
 *
 * UI helper for Grin Slatepack messages.
 *
 * Note: Actual Slatepack encoding/decoding is handled by the grin-wallet
 * binary and its API. This module only validates and formats Slatepack
 * strings for display and user input — it does NOT encode/decode the
 * cryptographic payload.
 *
 * Modern Grin Slatepack format:
 *   BEGINSLATEPACK. <base58check-encoded-payload> . ENDSLATEPACK.
 */

class SlateHandler {
    /**
     * Returns true if the text looks like a valid Slatepack message.
     * Checks for the BEGINSLATEPACK. / ENDSLATEPACK. markers used by grin-wallet v5+.
     */
    isValidSlatepack(text) {
        const t = text.trim();
        return /BEGINSLATEPACK\./i.test(t) && /ENDSLATEPACK\./i.test(t);
    }

    /**
     * Returns the trimmed Slatepack string as-is.
     * The wallet API accepts the full Slatepack text including markers.
     */
    extractPayload(slatepack) {
        return slatepack.trim();
    }

    /**
     * Formats a long Slatepack string for readable display (adds line breaks).
     */
    formatForDisplay(slatepack) {
        const trimmed = slatepack.trim();
        // Already has internal whitespace from the wallet — return as-is
        return trimmed;
    }
}

const slateHandler = new SlateHandler();
