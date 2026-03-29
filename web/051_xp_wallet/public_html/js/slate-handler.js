class SlateHandler {
    isValidSlatepack(text) {
        const t = text.trim();
        return /BEGINSLATEPACK\./i.test(t) && /ENDSLATEPACK\./i.test(t);
    }
    extractPayload(slatepack) { return slatepack.trim(); }
    formatForDisplay(slatepack) { return slatepack.trim(); }
}

const slateHandler = new SlateHandler();
