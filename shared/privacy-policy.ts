/**
 * Does the published privacy policy still describe what the app does? (#741)
 *
 * ## Why this exists
 *
 * On 2026-09-07 two changes made `frontend/public/privacy/index.html`
 * **factually wrong** within hours of each other, and nothing noticed:
 *
 * - #739 moved the update check to `dl.dlany.uk`. The policy still named
 *   `raw.githubusercontent.com` as the only host it contacts.
 * - Switching on Cloudflare's proxy put a third party in front of the whole
 *   site. The policy said "the web server keeps ordinary access logs".
 *
 * Both were corrected in #740, and ⚠️ **only because that file happened to be
 * open for an unrelated reason.** `deploy-stack.yml` asserts the page is
 * *served* — its title comes back and it is not the SPA fallback. Nothing
 * asserted it was *true*. A policy can be reachable, correctly built,
 * byte-identical to its source, and describe an app that no longer exists.
 *
 * ⛔ **#513 exists specifically to make that claim accurate.** A privacy policy
 * that omits a data processor is not a stale doc; it is the failure the issue
 * was opened to prevent.
 *
 * ## What this can and cannot catch
 *
 * ✅ It catches **a host the app can contact that the policy does not name**,
 * because the app's outbound hosts are constants in its own source. It would
 * have caught the `dl.dlany.uk` half on the commit that introduced it.
 *
 * ⛔ **It cannot catch the Cloudflare half, and no test can.** Turning on the
 * orange cloud changed **no file in this repo** — there was nothing to diff and
 * nothing to assert against. That half is a human step, written down in
 * `docs/deployment.md`: changing who sits in front of the site is a
 * privacy-policy change.
 *
 * ## Why it lives in `shared/` and runs in two suites
 *
 * ⚠️ **A guard that does not run is worse than no guard**, and this one has a
 * path filter on each side of it. `mobile.yml` lists `frontend/**` in
 * `paths-ignore` and `frontend.yml` lists `mobile/**`, so:
 *
 * - a mobile-only PR that adds a host runs **only** `mobile.yml`
 * - a frontend-only PR that edits the policy runs **only** `frontend.yml`
 *
 * A guard living in one suite is therefore blind in exactly one direction —
 * and the frontend direction is real, not theoretical: adding an eighth
 * language to the page is a frontend-only change that could omit a host from
 * the new block. So the logic is here, in `shared/`, which is in **no** ignore
 * list, and a thin test in each suite runs it. Same shape as #655: both halves
 * passing is not the join passing.
 */

/*
 * ⛔ **This file imports nothing, and cannot.** `@mio/shared` reaches both apps
 * as a symlink, so jest resolves its *real* path and then looks for helpers
 * like `@babel/runtime` from `shared/` upward — where there is no
 * `node_modules` at all. `shared/tokens.ts` has no imports for the same reason.
 *
 * So every reading from disk is injected. That also keeps the logic pure, which
 * is this repo's convention for anything that has to stay testable.
 */

/**
 * Where a host the app can contact is declared.
 *
 * ⚠️ **The hosts are read out of the source, never listed here.** A
 * hand-written list is the thing that goes stale — it would have to be updated
 * by the same person who forgot to update the policy, so it would catch
 * nothing. What is listed here is where to *look*, which changes far less
 * often, and `minimum` is the control that says the look succeeded.
 */
export type HostSource = {
  /** The declaration to read, for the failure message. */
  readonly label: string;
  /** Repo-relative file holding it. */
  readonly file: string;
  /** An `export const` in a TypeScript file… */
  readonly constant?: string;
  /** …or a path into a JSON file. */
  readonly jsonPath?: readonly string[];
  /**
   * How many hosts this declaration must yield.
   *
   * ⚠️ **This is the control.** A regex that stops matching is
   * indistinguishable from an app that contacts nothing — both produce an empty
   * set and a green test. A source that yields fewer hosts than it is known to
   * declare fails loudly instead.
   */
  readonly minimum: number;
};

/**
 * Every host MiO can reach that is MiO's own choice of host.
 *
 * ⚠️ **Deliberately not the media services.** YouTube, Bilibili, NetEase, QQ,
 * Kugou and Spotify are reached only because a user asked for a specific track,
 * their hostnames are scattered across a dozen fetchers, and the policy names
 * them *by service* in "What the app contacts when you ask it to" rather than
 * by hostname. Asserting on those would be asserting on prose. These five are
 * infrastructure the user never chose, so naming the host is the honest form.
 */
export const HOST_SOURCES: readonly HostSource[] = [
  {
    label: "LATEST_VERSION_URLS",
    file: "mobile/src/updates/latestVersion.ts",
    constant: "LATEST_VERSION_URLS",
    // R2 and GitHub. Two, because one of them is unreachable from China (#725).
    minimum: 2,
  },
  {
    label: "expo.updates.url",
    file: "mobile/app.json",
    jsonPath: ["expo", "updates", "url"],
    minimum: 1,
  },
  {
    label: "PRIVACY_URL",
    file: "mobile/src/legal.ts",
    constant: "PRIVACY_URL",
    minimum: 1,
  },
  {
    label: "KOFI_URL",
    file: "mobile/src/components/DonateCard.tsx",
    constant: "KOFI_URL",
    minimum: 1,
  },
  {
    // Opened the same way as the Ko-fi link, and already named in the policy —
    // which makes it this guard's own worked example rather than a new demand.
    label: "REPORT_FORM_URL",
    file: "mobile/src/diagnostics/report.ts",
    constant: "REPORT_FORM_URL",
    minimum: 1,
  },
];

/** The policy, relative to the repo root. */
export const POLICY_PATH = "frontend/public/privacy/index.html";

/**
 * Reads one repo-relative file, or throws naming it.
 *
 * Injected rather than imported — see the note at the top of this file about
 * why nothing here can `import`.
 */
export type ReadRepoFile = (repoRelativePath: string) => string;

/**
 * The initializer of `export const <name>`, as source text.
 *
 * ⚠️ **The docblock above a declaration is not part of it**, and that matters
 * here: `latestVersion.ts` explains an old bug using
 * `https://mio.dlany.uk/version.json` in prose, a host that declaration does
 * *not* contact. Slicing from the `=` is what keeps a comment from inventing an
 * obligation.
 */
function initializerOf(source: string, constant: string, file: string): string {
  // `[^=\n]*` covers an inline type annotation (`REPORT_FORM_URL: string =`).
  const declaration = new RegExp(
    `export const ${constant}\\b[^=\\n]*=\\s*`,
  ).exec(source);
  if (!declaration) {
    throw new Error(`${file} no longer declares \`export const ${constant}\``);
  }
  const start = declaration.index + declaration[0].length;
  const opener = source[start];

  if (opener === "[") {
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === "[") depth += 1;
      else if (source[i] === "]") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(
      `${file}: \`${constant}\` opens an array that never closes`,
    );
  }

  if (opener === "'" || opener === '"' || opener === "`") {
    const end = source.indexOf(opener, start + 1);
    if (end === -1)
      throw new Error(
        `${file}: \`${constant}\` opens a string that never closes`,
      );
    return source.slice(start, end + 1);
  }

  throw new Error(
    `${file}: \`${constant}\` is neither a string nor an array literal`,
  );
}

/** Every `https://` host inside a slice of source, from *quoted* strings only. */
function hostsIn(text: string): string[] {
  const found = new Set<string>();
  const url = /['"`]https:\/\/([^/'"`\s]+)/g;
  let match = url.exec(text);
  while (match) {
    found.add(match[1]);
    match = url.exec(text);
  }
  return [...found];
}

/** A host, and the declaration that proves the app can reach it. */
export type OutboundHost = { readonly host: string; readonly from: string };

/**
 * Every host the app can contact, read out of the app's own source.
 *
 * Throws rather than returning a short list: an extractor that has stopped
 * working must not look like an app that contacts nothing (#519's "a crashed
 * run and a clean run are identical if you only count failures").
 */
export function hostsTheAppCanContact(read: ReadRepoFile): OutboundHost[] {
  const out: OutboundHost[] = [];

  for (const source of HOST_SOURCES) {
    const text = read(source.file);

    let hosts: string[];
    if (source.jsonPath) {
      let value: unknown = JSON.parse(text);
      for (const key of source.jsonPath) {
        value = (value as Record<string, unknown> | null)?.[key];
      }
      hosts = typeof value === "string" ? hostsIn(`'${value}`) : [];
    } else if (source.constant) {
      hosts = hostsIn(initializerOf(text, source.constant, source.file));
    } else {
      throw new Error(
        `${source.label} declares neither a constant nor a JSON path`,
      );
    }

    if (hosts.length < source.minimum) {
      throw new Error(
        `read ${hosts.length} host(s) from \`${source.label}\` in ${source.file}, expected at ` +
          `least ${source.minimum}. The reader is broken, not the app — fix it before trusting ` +
          `a pass.`,
      );
    }
    for (const host of hosts) out.push({ host, from: source.label });
  }

  return out;
}

/**
 * The policy's text, one region per language the page offers.
 *
 * ⚠️ **The language list comes from the picker, not from a constant here.**
 * #695: a language in the picker with nothing behind it is invisible to every
 * other tool, so the list a user can actually select is the list a test must
 * read.
 *
 * English lives in the markup and the other six live in the page's own `I18N`
 * object, which is why the regions are found two different ways.
 */
export function policyRegions(read: ReadRepoFile): Map<string, string> {
  const html = read(POLICY_PATH);

  const picker = /<select id="lang"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (!picker)
    throw new Error(
      `${POLICY_PATH} has no \`<select id="lang">\` — cannot read languages`,
    );
  const languages = [...picker[1].matchAll(/<option value="([a-z-]+)"/g)].map(
    (m) => m[1],
  );
  if (languages.length < 2 || !languages.includes("en")) {
    throw new Error(
      `the picker offers ${JSON.stringify(languages)}, which cannot be right`,
    );
  }

  const dictionaryAt = html.indexOf("var I18N = {");
  if (dictionaryAt === -1)
    throw new Error(`${POLICY_PATH} has no \`var I18N\` block`);

  const regions = new Map<string, string>();
  for (const language of languages) {
    if (language === "en") {
      // The English text is the markup itself; the script below only replaces it.
      const bodyAt = html.indexOf("<main>");
      if (bodyAt === -1) throw new Error(`${POLICY_PATH} has no \`<main>\``);
      regions.set("en", html.slice(bodyAt, dictionaryAt));
      continue;
    }
    const opener = new RegExp(`\\n {8}${language}: \\{\\n`).exec(html);
    if (!opener) {
      throw new Error(
        `\`${language}\` is in the picker but has no \`${language}: {\` block in I18N — ` +
          `the page would list it and render English (#695)`,
      );
    }
    const from = opener.index;
    const closer = html.indexOf("\n        },", from);
    if (closer === -1)
      throw new Error(`\`${language}\`'s block in ${POLICY_PATH} never closes`);
    regions.set(language, html.slice(from, closer));
  }

  for (const [language, text] of regions) {
    // A region short enough to be a stub cannot meaningfully contain anything;
    // without this a mis-sliced region would pass every "is the host absent" check
    // by being absent itself. Every real block is several thousand characters.
    if (text.length < 1000) {
      throw new Error(
        `\`${language}\`'s region is ${text.length} chars — the slicing is wrong`,
      );
    }
  }

  return regions;
}
