# fixtures/

Saved korter.ge pages used by the parser-compatibility tests
(`test/extract.test.ts` and gated blocks elsewhere).

**They are not distributed.** The HTML files are korter's content; publishing
them would be republication (see the operating rules), so they exist only in
the internal repo and are stripped from the public snapshot. Every test that
exercises this project's own machinery runs against the invented pages in
`test/synthetic.ts` instead, so `pnpm test` passes without these files — the
real-page tests simply skip.

To (re)create them for local parser work: fetch the three pages listed in
`docs/schema-notes.md` yourself — at most one request per second, with the
honest User-Agent from `src/config.ts`, after checking `robots.txt` — and save
them here under the same names. Do not commit them to a public tree.
