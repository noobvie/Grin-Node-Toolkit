// Use strict
"use strict";


// Classes

// MQS class
class Mqs {

	// ACCIO PATCH — S9 deletion pass 1. The MQS subsystem is deleted.
	//
	// MQS (the MimbleWimble Coin "message queue service") is a slate transport:
	// a WebSocket client that connects to a host named INSIDE a slate URL,
	// subscribes to a queue keyed by a secp256k1 address, signs a server-issued
	// challenge, and exchanges PBKDF2 + AES-GCM encrypted payloads. Upstream
	// ships 1361 lines of it. Accio is a Grin wallet that receives over Tor and
	// the gateway, so none of that is ours to run — and a self-custodial wallet
	// should not carry an unreachable network client that talks to a host an
	// attacker-supplied string chooses.
	//
	// WHY THIS IS A REDUCTION AND NOT A `rm`. Five symbols of this class are
	// referenced from outside it, in 36 places across api.js, slate.js,
	// wallet.js, hardware_wallet.js and send_payment_section.js — none of which
	// we patch, because they are 40,000 lines / 1.65 MB of the money path and a
	// whole-file overlay of them would make every future `git log <PIN>..upstream`
	// review a manual merge (patches/README.md, "Why an overlay and not surgery").
	// Delete the file outright and `Mqs.ADDRESS_LENGTH` becomes a ReferenceError
	// in Slate.compactProofAddress — which is on the slatepack ENCODE path, is
	// not wallet-type-gated, and runs on every payment proof we send. That is
	// the money path breaking on a "free" cleanup. So the external surface stays
	// and everything behind it goes.
	//
	// WHY THIS CHANGES NO BEHAVIOUR. Consensus.getWalletType() returns Grin
	// unconditionally here (scripts/consensus.js, S5), and upstream's MQS is
	// already dead in Grin mode — provably, not by inspection:
	//
	//   • getAddressVersion() has cases for MWC and EPIC only, so it returns
	//     undefined for Grin. Both codecs then fault on `version["length"]`
	//     before they can produce or accept an address. They could only ever
	//     throw; they now throw upstream's own strings instead of a TypeError.
	//   • isValidAddressWithHost() catches that fault and returns false. It
	//     could only ever return false; it now says so in one line.
	//   • sendRequest() is called from exactly one place — api.js, inside
	//     `case Consensus.EPIC_WALLET_TYPE`. Every MWC/GRIN arm of those five
	//     switches sets `sendAsMqs = false` by hand. It is unreachable, not
	//     merely unused.
	//
	// So every reachable call site sees the same outcome it saw before, at every
	// one of the 36 references. What is gone is the transport behind them.
	//
	// WHAT IS DELIBERATELY KEPT. ADDRESS_LENGTH is 52 and stays 52. It is not
	// branding and it is not dead: slate.js switches on a proof address's LENGTH
	// to decide how to parse it, and Slate.uncompactProofAddress reads a leading
	// bit that says "this proof address is MQS". That is wire format. Changing
	// or removing the constant would silently re-route a 52-character proof
	// address into the Tor branch instead of rejecting it — a parsing change on
	// the money path, dressed up as a deletion. Removing MQS must not change how
	// a slate is read; it must only remove what we would do about one.
	//
	// Reverting this pass is `git rm` on this file — the build then overlays
	// nothing here and upstream's mqs.js ships as vendored.

	// Public

		// Public key to MQS address
		static publicKeyToMqsAddress(publicKey, isMainnet) {

			// Throw error
			throw "Invalid public key.";
		}

		// MQS address to public key
		static mqsAddressToPublicKey(mqsAddress, isMainnet) {

			// Throw error
			throw "Invalid MQS address.";
		}

		// Is valid address with host
		static isValidAddressWithHost(url, isMainnet) {

			// Return false
			return false;
		}

		// Send request
		static sendRequest(url, slate, secretKey, isMainnet, cancelOccurred = Common.NO_CANCEL_OCCURRED) {

			// Return rejected promise
			return Promise.reject("Invalid MQS address.");
		}

		// Address length
		static get ADDRESS_LENGTH() {

			// Return address length
			return 52;
		}
}


// Main function

// Set global object's MQS
globalThis["Mqs"] = Mqs;
