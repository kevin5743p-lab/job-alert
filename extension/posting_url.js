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
