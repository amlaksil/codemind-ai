# Skill and job-title dictionaries

`skills.json` is derived from the curated dictionaries of
[freehire](https://github.com/strelov1/freehire) (MIT licence), ported as data:

- `wordAliases`, `phraseAliases`, `ambiguousWords`, `acronyms`, `nonCorroboratingPhrases`
  from `internal/dict/skilltag/dictionaries.go`
- `labels` from `internal/dict/skilltag/labels.go`
- `descriptions` from `internal/dict/skilltag/descriptions.tsv`
- `techTitleTerms` and `nonTechTitleTerms` from `internal/dict/classify/`

Do not edit the JSON by hand. Regenerate it from a freehire checkout with

    npm run gen:skill-dict -- ../../freehire-main

(`src/cli/dict/genSkills.js`), and commit the result.

# Industry dictionary

`industries.json` is derived from freehire's `internal/dict/industrytag` (MIT): `labels`
(`labels.go` `displayNames`), the canonical industries and the text each renders as, and
`aliases` (`dictionaries.go`), the raw labels that mean one of them without being spelled like
it. `domains.go` is not ported — it translates freehire's own job-domain vocabulary, which we do
not have. Do not edit the JSON by hand; regenerate it with

    npm run gen:industry-dict -- ../../freehire-main

(`src/cli/dict/genIndustries.js`), and commit the result. `dict/industries.js` reads it and
layers our own entries over it: LinkedIn's industry taxonomy, which reaches us through Remote
Rocketship and Indeed and which freehire never had to read, plus `consulting`, the commonest
label our sources send and one freehire's vocabulary does not name.

# City gazetteer and country dictionary

`cities1000.tsv` is the city gazetteer freehire generates from
[GeoNames](https://www.geonames.org/) `cities1000` (CC-BY 4.0; the header comment carries the
attribution) and ships as `internal/dict/location/cities1000.tsv`: one row per place with a
population of 1,000 or more, `canonical-name<TAB>ISO-alpha2<TAB>alias|alias|...`, most populous
first. A trailing `*` marks an alias that more than one country claims, counted across the whole
GeoNames dump, hamlets included; such an alias states no country. `text/dict/cities.js` reads it on the
first lookup. It is copied as is from a freehire checkout.

`countries.json` is derived from freehire's `internal/dict/location/dictionaries.go` (MIT):
`nameToCountry` (country names in several languages, ATS shorthands and hand-pinned beacon
cities, each to an ISO 3166-1 alpha-2 code), `subdivisionToCountry` (US states and Canadian
provinces) and `regionCountries` (the macro-regions and the codes they group). `text/dict/cities.js`
layers the pinned spellings over the gazetteer, and `countries.test.js` checks the hand-written
table in `countries.js` against it. Do not edit the JSON by hand; regenerate it with

    npm run gen:country-dict -- ../../freehire-main

(`src/cli/dict/genCountries.js`), and commit the result.
