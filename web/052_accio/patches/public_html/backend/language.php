<?php

	// Constants

	// Default language
	const DEFAULT_LANGUAGE = "en-US";
	
	// Default locale
	const DEFAULT_LOCALE = "en_US.UTF-8";
	
	// Single quote HTML entity
	const SINGLE_QUOTE_HTML_ENTITY = "&#39;";
	
	// Ampersand HTML entity
	const AMPERSAND_HTML_ENTITY = "&amp;";
	
	// Number format minimum fraction digits
	const NUMBER_FORMAT_MINIMUM_FRACTION_DIGITS = 0;
	
	// Number format maximum fraction digits
	const NUMBER_FORMAT_MAXIMUM_FRACTION_DIGITS = 9;
	
	// Number format use grouping
	const NUMBER_FORMAT_USE_GROUPING = FALSE;
	
	// Bitcoin currency name
	const BITCOIN_CURRENCY_NAME = "BTC";
	
	// Ethereum currency name
	const ETHEREUM_CURRENCY_NAME = "ETH";
	
	// Escape character
	const ESCAPE_CHARACTER = "%";
	
	// Placeholder pattern
	const PLACEHOLDER_PATTERN = '/^' . ESCAPE_CHARACTER . '[1-9]\d*\$s$/u';

	// ACCIO PATCH — brand substitutions
	//
	// Every user-visible string in this app is a translation, and every
	// translation passes through getDefaultTranslation() or getTranslation().
	// Rebranding here therefore covers index.html, site.webmanifest and all
	// eight errors/*.html at once, in all six languages, WITHOUT overlaying
	// any of those files. The client-side twin lives in scripts/language.js
	// and must carry the same map.
	//
	// This map is deliberately PHRASES, never the bare token "MWC" — that
	// token is the MWC ticker and a protocol discriminator, and rewriting it
	// is the exact hazard docs/generated/script052_design.md §"Naming policy"
	// layer 3 forbids. Layer 3 is deleted in S9+, never renamed.
	const BRAND_SUBSTITUTIONS = [
		"MWC Wallet" => "Accio",
		"MimbleWimble Coin" => "Grin",

		// Upstream invites translators by email; we have no mailbox for that,
		// so scripts/language.js remaps the address argument to our issue
		// tracker and this rewrites the sentence around it. Only the English
		// phrasing matches — other languages keep their own wording.
		"You can email %1\$m" => "You can open an issue at %1\$m",

		// ── The translated spellings of the same two brands ──────────────────
		//
		// Added by the R8 review. The two entries above are English PHRASES,
		// and three of the six translators did not keep the English word
		// order: Dutch writes "MWC Portemonnee", Greek "Πορτοφόλι MWC" and
		// "Νόμισμα MimbleWimble", Simplified Chinese "MWC钱包" and
		// "MimbleWimble币". Those values never matched, so 27 strings shipped
		// unbranded in exactly the places a brand is load-bearing — the page
		// <title>, the error and maintenance titles, the About blurb, and
		// (Greek and Chinese) the CURRENCY LABEL beside a balance, where a
		// Grin wallet was telling the user it held MimbleWimble Coin.
		//
		// Measured, not guessed: languages/{dutch,greek,simplified_chinese}
		// .php, every entry in the Text table, branded, then grepped for MWC
		// and MimbleWimble. 27 hits before, 0 after. czech and german needed
		// nothing — they kept the English word order.
		//
		// Keep prose out of this block that looks like an entry: the R8
		// checker extracts both maps with a regex and compares them, and it
		// cannot tell a commented example from a live pair.
		//
		// This is still the PHRASES rule, not a bare-token rule: every pattern
		// below carries the brand's own noun with it. When a new language is
		// added, re-run that check before shipping it.

		// Dutch — "wallet" translated, brand kept in front
		"MWC Portemonnee" => "Accio",
		"MWC portemonnee" => "Accio",

		// Greek — noun first, brand second, in both cases the noun takes
		"Πορτοφόλι MWC" => "Accio",
		"Νόμισμα MimbleWimble" => "Grin",
		"MimbleWimble Νόμισμα" => "Grin",
		"MimbleWimble νόμισμα" => "Grin",

		// Simplified Chinese — no separator, and one string with a space
		"MWC 钱包" => "Accio",
		"MWC钱包" => "Accio",
		"MimbleWimble币" => "Grin"
	];


	// Supporting function implementation

	// ACCIO PATCH — apply the brand substitutions to a string
	function brandText($text) {

		// Check if text isn't a string
		if(is_string($text) === FALSE)

			// Return text
			return $text;

		// Return text with the brand substitutions applied
		return str_replace(array_keys(BRAND_SUBSTITUTIONS), array_values(BRAND_SUBSTITUTIONS), $text);
	}

	// Get available languages
	function getAvailableLanguages() {
	
		// Declare available languages
		static $availableLanguages;
		
		// Check if available languages doesn't exist
		if(isset($availableLanguages) === FALSE) {
		
			// Set available languages
			$availableLanguages = [];
		
			// Check if getting language files was successful
			$languageFiles = scandir(__DIR__ . "/../languages");
			if($languageFiles !== FALSE) {
			
				// Go through all language files
				foreach($languageFiles as $languageFile) {
				
					// Check if language file is a file
					$file = __DIR__ . "/../languages/" . $languageFile;
					if(is_file($file) === TRUE)
					
						// Include language file
						require $file;
				}
				
				// ACCIO PATCH — rebrand every translation, key and value
				//
				// The KEY must be branded too, not just the value. Lookups
				// arrive already branded (getTranslation brands its argument),
				// and the whole table is re-exported to the browser verbatim by
				// scripts/languages.js — so a table keyed on upstream's strings
				// would miss on the server AND ship "MWC Wallet" to every
				// client that switches language.
				foreach($availableLanguages as &$availableLanguage) {

					// Check if language has text
					if(array_key_exists("Text", $availableLanguage) === TRUE) {

						// Go through all of the language's text
						$brandedText = [];
						foreach($availableLanguage["Text"] as $key => $value)

							// Rebrand the text
							$brandedText[brandText($key)] = brandText($value);

						// Set the language's text to the rebranded text
						$availableLanguage["Text"] = $brandedText;
					}
				}

				// Break the reference the loop above left behind
				unset($availableLanguage);

				// Sort available languages by language name
				uasort($availableLanguages, function($firstValue, $secondValue) {

					return strcoll($firstValue["Constants"]["Language"], $secondValue["Constants"]["Language"]);
				});
			}
		}
		
		// Return available languages
		return $availableLanguages;
	}
	
	// Get language
	function getLanguage() {
	
		// Declare language
		static $language;
		
		// Check if language doesn't exist
		if(isset($language) === FALSE) {
		
			// Get locale language
			$localeLanguage = (array_key_exists("HTTP_ACCEPT_LANGUAGE", $_SERVER) === TRUE && is_string($_SERVER["HTTP_ACCEPT_LANGUAGE"]) === TRUE && mb_strlen($_SERVER["HTTP_ACCEPT_LANGUAGE"]) !== 0) ? locale_accept_from_http($_SERVER["HTTP_ACCEPT_LANGUAGE"]) : FALSE;
			
			// Check if local language is should be simplified Chinese
			if($localeLanguage === "zh" && mb_strstr($_SERVER["HTTP_ACCEPT_LANGUAGE"], "zh-CN") !== FALSE) {
			
				// Set local language to simplified Chinese
				$localeLanguage = "zh_CN";
			}
			
			// Get language parameter
			$languageParameter = (array_key_exists("Language", $_GET) === TRUE && is_string($_GET["Language"]) === TRUE && mb_strlen($_GET["Language"]) !== 0) ? $_GET["Language"] : FALSE;
			
			// Get prefered languages
			$preferedLanguages = array_unique(($languageParameter === FALSE) ? (($localeLanguage === FALSE) ? ((array_key_exists("__Host-Language", $_COOKIE) === FALSE || is_string($_COOKIE["__Host-Language"]) === FALSE || mb_strlen($_COOKIE["__Host-Language"]) === 0) ? [
			
				// Default language
				DEFAULT_LANGUAGE
			
			] : [
			
				// Choosen language
				$_COOKIE["__Host-Language"],
				
				// Default language
				DEFAULT_LANGUAGE
			
			]) : ((array_key_exists("__Host-Language", $_COOKIE) === FALSE || is_string($_COOKIE["__Host-Language"]) === FALSE || mb_strlen($_COOKIE["__Host-Language"]) === 0) ? [
			
				// Locale language with variant
				preg_replace('/_/u', "-", $localeLanguage),
				
				// Locale language without variant
				preg_split('/_/u', $localeLanguage)[0],
				
				// Default language
				DEFAULT_LANGUAGE
			
			] : [
			
				// Choosen language
				$_COOKIE["__Host-Language"],
			
				// Locale language with variant
				preg_replace('/_/u', "-", $localeLanguage),
				
				// Locale language without variant
				preg_split('/_/u', $localeLanguage)[0],
				
				// Default language
				DEFAULT_LANGUAGE
			
			])) : (($localeLanguage === FALSE) ? ((array_key_exists("__Host-Language", $_COOKIE) === FALSE || is_string($_COOKIE["__Host-Language"]) === FALSE || mb_strlen($_COOKIE["__Host-Language"]) === 0) ? [
			
				// Language parameter
				$languageParameter,
				
				// Default language
				DEFAULT_LANGUAGE
			
			] : [
			
				// Choosen language
				$_COOKIE["__Host-Language"],
				
				// Language parameter
				$languageParameter,
				
				// Default language
				DEFAULT_LANGUAGE
			
			]) : ((array_key_exists("__Host-Language", $_COOKIE) === FALSE || is_string($_COOKIE["__Host-Language"]) === FALSE || mb_strlen($_COOKIE["__Host-Language"]) === 0) ? [
			
				// Language parameter
				$languageParameter,
				
				// Locale language with variant
				preg_replace('/_/u', "-", $localeLanguage),
				
				// Locale language without variant
				preg_split('/_/u', $localeLanguage)[0],
				
				// Default language
				DEFAULT_LANGUAGE
			
			] : [
			
				// Choosen language
				$_COOKIE["__Host-Language"],
			
				// Language parameter
				$languageParameter,
				
				// Locale language with variant
				preg_replace('/_/u', "-", $localeLanguage),
				
				// Locale language without variant
				preg_split('/_/u', $localeLanguage)[0],
				
				// Default language
				DEFAULT_LANGUAGE
			])));
			
			// Get available languages
			$availableLanguages = getAvailableLanguages();
			
			// Go through all prefered languages
			foreach($preferedLanguages as $preferedLanguage) {
			
				// Check if prefered language is available
				if(array_key_exists($preferedLanguage, $availableLanguages) === TRUE) {
				
					// Set language
					$language = $preferedLanguage;
					
					// Break
					break;
				}
			}
			
			// Check if language doesn't exist
			if(isset($language) === FALSE)
			
				// Set language to default lnaguage
				$language = DEFAULT_LANGUAGE;
		}
		
		// Return language
		return $language;
	}
	
	// Get language currencies
	function getLanguageCurrencies() {
	
		// Declare language currencies
		static $languageCurrencies;
		
		// Check if language currencies doesn't exist
		if(isset($languageCurrencies) === FALSE) {
		
			// Set language currencies
			$languageCurrencies = [
			
				// Bitcoin currency name
				BITCOIN_CURRENCY_NAME,
				
				// Ethereum currency name
				ETHEREUM_CURRENCY_NAME
			];
			
			// Go through all available languages
			foreach(getAvailableLanguages() as $languageIdentifier => $availableLanguage) {
			
				// Check if available language has a currency constant
				if(array_key_exists("Currency", $availableLanguage["Constants"]) === TRUE) {
				
					// Get available language's currency
					$currency = $availableLanguage["Constants"]["Currency"];
					
					// Check if currency isn't already in the list of language currencies
					if(in_array($currency, $languageCurrencies, TRUE) === FALSE)
					
						// Append currency to list of language currencies
						array_push($languageCurrencies, $currency);
				}
			}
				
			// Sort language currencies by currency name
			usort($languageCurrencies, function($firstValue, $secondValue) {
				
				return strcoll($firstValue, $secondValue);
			});
		}
		
		// Return language currencies
		return $languageCurrencies;
	}
	
	// Get translation contributors
	function getTransactionContributors() {
	
		// Declare translation contributors
		static $translationContributors;
		
		// Check if translation contributors doesn't exist
		if(isset($translationContributors) === FALSE) {
		
			// Set translation contributors
			$translationContributors = [];
			
			// Go through all available languages
			foreach(getAvailableLanguages() as $languageIdentifier => $availableLanguage) {
			
				// Check if available language has contributors
				if(array_key_exists("Contributors", $availableLanguage) === TRUE) {
				
					// Get available language's contributors
					$contributors = $availableLanguage["Contributors"];
					
					// Go through all contributors
					foreach($contributors as $contributor => $link) {
					
						// Check if contributor doesn't have a link
						if(is_int($contributor) === True) {
						
							// Check if contributor isn't already in the list of translation contributors
							if(in_array($link, $translationContributors, TRUE) === FALSE)
							
								// Append contributor to list of translation contributors
								array_push($translationContributors, $link);
						}
						
						// Otherwise
						else {
						
							// Check if contributor isn't already in the list of translation contributors
							if(in_array($contributor, $translationContributors, TRUE) === FALSE)
							
								// Append contributor to list of translation contributors
								$translationContributors[$link] = $contributor;
						}
					}
				}
			}
			
			// Sort translation contributors by contributor name
			uasort($translationContributors, function($firstValue, $secondValue) {
				
				return strcoll($firstValue, $secondValue);
			});
		}
		
		// Return translation contributors
		return $translationContributors;
	}
	
	// Get translated type value
	function getTranslatedTypeValue($type, $value, $language = NULL) {
	
		// Check if language isn't provided
		if($language === NULL) {
		
			// Get language
			$language = getLanguage();
		}
		
		// Check if type is text and value is a standalone placeholder
		if($type === "Text" && preg_match(PLACEHOLDER_PATTERN, $value) === 1) {
		
			// Return value and the language used
			return [
			
				// Result
				"Result" => $value,
				
				// Language
				"Language" => $language
			];
		}
		
		// Otherwise
		else {
		
			// Get available languages
			$availableLanguages = getAvailableLanguages();
		
			// Loop until a result is returned
			while(TRUE) {
			
				// Check if language is available
				if(array_key_exists($language, $availableLanguages) === TRUE) {
			
					// Check if specified type exist for the language and the specified value exists
					if(array_key_exists($type, $availableLanguages[$language]) === TRUE && array_key_exists($value, $availableLanguages[$language][$type]) === TRUE)
					
						// Return value for the language and the language used
						return [
						
							// Result
							"Result" => $availableLanguages[$language][$type][$value],
							
							// Language
							"Language" => $language
						];
					
					// Otherwise check if language provided a fallback language
					else if($language !== DEFAULT_LANGUAGE && array_key_exists("Constants", $availableLanguages[$language]) === TRUE && array_key_exists("Fallback", $availableLanguages[$language]["Constants"]) === TRUE)
					
						// Set language to the language's fallback language
						$language = $availableLanguages[$language]["Constants"]["Fallback"];
					
					// Otherwise check if the language is not the default language
					else if($language !== DEFAULT_LANGUAGE)
					
						// Set language to default language
						$language = DEFAULT_LANGUAGE;
					
					// Otherwise
					else {
					
						// Check if type is constants
						if($type === "Constants") {
					
							// Return empty string and the language used
							return [
							
								// Result
								"Result" => "",
								
								// Language
								"Language" => $language
							];
						}
						
						// Otherwise assume type is text
						else {
						
							// Return value and the language used
							return [
							
								// Result
								"Result" => $value,
								
								// Language
								"Language" => $language
							];
						}
					}
				}
				
				// Otherwise check if the language is not the default language
				else if($language !== DEFAULT_LANGUAGE)
				
					// Set language to default language
					$language = DEFAULT_LANGUAGE;
				
				// Otherwise
				else {
				
					// Check if type is constants
					if($type === "Constants") {
				
						// Return empty string and the language used
						return [
						
							// Result
							"Result" => "",
							
							// Language
							"Language" => $language
						];
					}
					
					// Otherwise assume type is text
					else {
					
						// Return value and the language used
						return [
						
							// Result
							"Result" => $value,
							
							// Language
							"Language" => $language
						];
					}
				}
			}
		}
	}
	
	// Get constant
	function getConstant($constant, $language = NULL) {
	
		// Return translation for the specified constant
		return getTranslatedTypeValue("Constants", $constant, $language)["Result"];
	}
	
	// Get translation
	function getTranslation($text, $arguments = [], $language = NULL) {

		// ACCIO PATCH — rebrand the lookup key to match the rebranded table
		$text = brandText($text);

		// Get translated text
		$translatedText = getTranslatedTypeValue("Text", $text, $language);
	
		// Go through all arguments
		foreach($arguments as &$argument) {
		
			// Check if argument is a function
			if(is_callable($argument) === TRUE)
			
				// Resolve the argument's value using the translated text's language
				$argument = $argument($translatedText["Language"], $text);
		}
	
		// Get formatted translation for the specified text
		$formattedTranslation = vsprintf($translatedText["Result"], $arguments);
		
		// Check if formatting translation failed
		if($formattedTranslation === FALSE)
		
			// Return empty string
			return "";
		
		// Otherwise
		else
		
			// Return formatted translation
			return $formattedTranslation;
	}
	
	// Get default translation
	function getDefaultTranslation($text) {

		// ACCIO PATCH — this is what becomes every data-text attribute, i.e.
		// the key the client-side translator looks up. Brand it here and the
		// client agrees with the rebranded table without any further work.
		return brandText($text);
	}
	
	// Get number translation
	function getNumberTranslation($number) {
	
		// Check if number isn't valid
		if(is_string($number) === TRUE || is_numeric($number) === FALSE) {
		
			// Return function
			return function($language, $value) {
		
				// Return empty string
				return "";
			};
		}
		
		// Otherwise
		else {
	
			// Return function
			return function($language, $value) use ($number) {
			
				// Get available languages
				$availableLanguages = getAvailableLanguages();
				
				// Loop until a result is returned
				while(TRUE) {
				
					// Check if language is available or value is a standalone placeholder
					if(array_key_exists($language, $availableLanguages) === TRUE || preg_match(PLACEHOLDER_PATTERN, $value) === 1) {
					
						// Set number formatter
						$numberFormatter = new NumberFormatter($language, NumberFormatter::DECIMAL);
						
						// Check if number formatter is valid and it can format using the provided language
						if($numberFormatter !== FALSE && preg_replace('/_/u', "-", $numberFormatter->getLocale(Locale::VALID_LOCALE)) === $language) {
						
							// Configure number formatter
							$numberFormatter->setAttribute(NumberFormatter::MIN_FRACTION_DIGITS, NUMBER_FORMAT_MINIMUM_FRACTION_DIGITS);
							$numberFormatter->setAttribute(NumberFormatter::MAX_FRACTION_DIGITS, NUMBER_FORMAT_MAXIMUM_FRACTION_DIGITS);
							$numberFormatter->setAttribute(NumberFormatter::GROUPING_USED, NUMBER_FORMAT_USE_GROUPING);
							$numberFormatter->setAttribute(NumberFormatter::ROUNDING_MODE, NumberFormatter::ROUND_DOWN);
							
							// Return number formatted as the language
							return $numberFormatter->format($number);
						}
						
						// Otherwise check if language provided a fallback language
						else if($language !== DEFAULT_LANGUAGE && array_key_exists("Constants", $availableLanguages[$language]) === TRUE && array_key_exists("Fallback", $availableLanguages[$language]["Constants"]) === TRUE)
						
							// Set language to the language's fallback language
							$language = $availableLanguages[$language]["Constants"]["Fallback"];
						
						// Otherwise check if the language is not the default language
						else if($language !== DEFAULT_LANGUAGE)
						
							// Set language to default language
							$language = DEFAULT_LANGUAGE;
						
						// Otherwise
						else
						
							// Return number
							return $number;
					}
					
					// Otherwise check if the language is not the default language
					else if($language !== DEFAULT_LANGUAGE)
					
						// Set language to default language
						$language = DEFAULT_LANGUAGE;
					
					// Otherwise
					else
					
						// Return number
						return $number;
				}
			};
		}
	}
	
	// Escape text
	function escapeText($text) {
	
		// Return text with all escape characters escaped
		return preg_replace('/' . ESCAPE_CHARACTER . '/u', ESCAPE_CHARACTER . ESCAPE_CHARACTER, $text);
	}
	
	// Escape Data
	function escapeData($array) {
	
		// Return array in JSON encoding with ampersands and single quotes encoded as HTML
		return preg_replace('/\'/u', SINGLE_QUOTE_HTML_ENTITY, preg_replace('/&/u', AMPERSAND_HTML_ENTITY, json_encode($array)));
	}
	
	
	// Main function
	
	// Set locale
	setlocale(LC_ALL, DEFAULT_LOCALE);
?>
