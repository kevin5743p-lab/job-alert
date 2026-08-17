// posting_url.js — does a link point at one job, or at a careers portal?
//
// Pure and dependency-free, like job_key.js, so it can be tested without the
// chrome API. router.js reaches the debugger through apply_agent, so anything
// living there is untestable outside a browser — and this is exactly the kind
// of string-handling rule that needs tests.

/**
 * True when the URL identifies a specific posting.
 *
 * A real posting is identified by something: an id somewhere in the path, or a
 * query string carrying a requisition id. A portal root has neither, and
 * opening one lands the apply agent on a search page with no form to fill —
 * after it has already rendered the CV and cover letter as PDFs and spent an
 * Anthropic call looking at the page. The user sees "it went to the wrong
 * website", because it did.
 *
 * Not hypothetical. One SuccessFactors posting arrived from a generic feed as
 * `https://career5.successfactors.eu/career`, with the
 * `?company=…&career_job_req_id=…` that names the job stripped off. The twelve
 * others from the same host kept theirs and applied fine.
 *
 * Deliberately narrow: it rejects only when there is NO query string AND the
 * path has at most one segment. Both must be true, so `/careers?jobId=123`
 * passes on its query and `/jobs/view/44524017` passes on its path. A false
 * reject costs one manual application; a false accept costs a wasted run, real
 * money, and the user's confidence in the thing.
 */
export function looksLikeAPosting(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return false;                       // not a URL at all
  }
  if (u.search && u.search.length > 1) return true;

  const segments = u.pathname.split("/").filter(Boolean);
  return segments.length > 1;
}

/**
 * Query parameters that are about how you ARRIVED, never about which job it is.
 *
 * A denylist, not an allowlist, and that direction is deliberate. Dropping a
 * parameter we should have kept destroys the posting's identity; keeping one we
 * could have dropped costs a duplicate row at worst. The first is silent and
 * expensive, the second is visible and cheap.
 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "msclkid", "twclid", "igshid", "mc_cid", "mc_eid",
  "ref", "referrer", "referer", "source", "src", "trk", "trackingid",
  "trk_ref", "refid", "sid", "cid", "eid",
  "lipi", "li_fat_id", "recommendedflavor", "originalsubdomain",
  "position", "pagenum", "pagenumber", "page", "savedsearchid", "seniority",
  "appcast", "appcastsrc", "appcast_source", "jobboard", "campaignid",
  "gh_src", "rx_source", "rx_campaign", "rx_medium", "rx_group", "rx_job",
  "iis", "iisn", "from", "hl",
]);

/**
 * One posting, one URL — including the query string when that is what names it.
 *
 * The old rule was `origin + pathname`, on the reasoning that query strings are
 * tracking noise. On consumer job boards that holds. On enterprise ATS software
 * it is precisely backwards: SuccessFactors identifies a posting ENTIRELY in
 * the query —
 *
 *   https://career5.successfactors.eu/career?company=VWAGLPPROD10
 *                                           &career_job_req_id=28826
 *
 * — and the path is the same `/career` for every job at every company on the
 * host. Stripping it collapsed all of them onto one URL. In practice that meant
 * every Volkswagen, BMW and Schaeffler posting the user tailored overwrote the
 * previous one in a single row, and none of them ever linked back to the
 * application the scanner had found under the real URL. The dashboard showed a
 * tailored job whose Apply button was permanently disabled, because the row it
 * was reading had no tailoring attached.
 *
 * So: keep the query, minus the parameters that are demonstrably about
 * referral.
 *
 * DELIBERATELY CONSERVATIVE BEYOND THAT. Parameter order is preserved and a
 * trailing slash is left alone, even though normalising both would be tidier.
 * This function computes the key that rows are already stored under, and every
 * cosmetic change forks a row: sorting the query would orphan every
 * SuccessFactors posting already in the table, and trimming the slash would
 * orphan every LinkedIn one. A URL with no tracking parameters must come back
 * byte-identical, and that property is worth more than tidiness.
 */
export function canonicalPostingUrl(url) {
  const raw = String(url || "");
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;                          // not a URL; hand it back untouched
  }
  if (!u.search || u.search.length <= 1) {
    return u.hash ? raw.slice(0, raw.indexOf("#")) : raw;
  }

  // Rebuilt from the original text rather than from URLSearchParams, so
  // untouched parameters keep their exact encoding.
  const kept = u.search.slice(1).split("&").filter((pair) => {
    if (!pair) return false;
    const name = decodeURIComponent(pair.split("=")[0] || "").toLowerCase();
    return !TRACKING_PARAMS.has(name);
  });

  return `${u.origin}${u.pathname}${kept.length ? `?${kept.join("&")}` : ""}`;
}
