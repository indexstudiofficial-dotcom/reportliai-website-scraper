/**
 * ============================================================
 * REPORTLI AI - WEBSITE SCRAPER WORKER (FIXED)
 * ============================================================
 *
 * FIXES APPLIED vs original:
 *
 * 1. saveBusinessData() errors are now returned to the caller
 *    and surfaced in the final JSON response (field_errors),
 *    instead of only being console.error'd. This is almost
 *    certainly why "nothing was saving": Supabase was
 *    rejecting the upsert and the failure was invisible.
 *
 * 2. The most likely underlying cause: the upsert uses
 *    ?on_conflict=application_id,field which REQUIRES a
 *    unique constraint on (application_id, field) in the
 *    business_data table. If that constraint doesn't exist,
 *    every single insert fails with Postgres error 42P10.
 *    Run this once in Supabase SQL editor:
 *
 *      alter table business_data
 *      add constraint business_data_app_field_unique
 *      unique (application_id, field);
 *
 * 3. Pages are no longer fetched twice (once during discovery,
 *    once during processing). discoverPages() now returns the
 *    HTML it already downloaded, and the main loop reuses it.
 *    This roughly halves subrequest usage and avoids silently
 *    hitting Cloudflare Workers' per-request subrequest limit
 *    (50 on Free plans) when crawling many pages.
 *
 * 4. Sarvam call now falls back to a plain (non-json_schema)
 *    request if the strict json_schema response_format is
 *    rejected by the API, so a single unsupported-parameter
 *    error doesn't take down every page.
 *
 * 5. SSRF blocklist now also covers the cloud metadata IP
 *    (169.254.169.254 / link-local) and IPv6 loopback/private
 *    ranges.
 *
 * FLOW:
 *
 * SaaS -> Worker -> Validate application -> Discover internal
 * pages (fetch once, cache HTML) -> Extract readable text ->
 * Send page to Sarvam -> Receive structured fields -> Save to
 * Supabase business_data (errors now reported) -> Next page
 * ============================================================
 */


/* ============================================================
   CONFIGURATION
   ============================================================ */

// Keep this conservative. Every page costs at least:
//   1 fetch (during discovery) + 1 Sarvam call + N Supabase saves
// Cloudflare Workers has a subrequest limit per request
// (50 on Free plans, 1000 on paid). 50 pages * several
// subrequests each will blow through that on Free plans.
const MAX_PAGES = 20;

// Maximum HTML size we will process per page.
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// Maximum text characters sent to Sarvam per page.
const MAX_TEXT_CHARS = 30000;

// Timeout for fetching websites.
const FETCH_TIMEOUT_MS = 15000;

// Sarvam endpoint / model.
const SARVAM_API_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

// Safety margin under Cloudflare's subrequest limit. We stop
// discovering/processing new pages once we're within this
// many subrequests of the cap, so we finish cleanly instead
// of failing mid-crawl. Adjust if you're on a paid plan.
const SUBREQUEST_SAFETY_LIMIT = 45;


/* ============================================================
   SUBREQUEST COUNTER
   ============================================================ */

// Cloudflare doesn't expose a live counter, so we track our
// own estimate and stop proactively rather than finding out
// via failed fetches.
let subrequestCount = 0;

function trackSubrequest() {
  subrequestCount++;
}

function nearSubrequestLimit() {
  return subrequestCount >= SUBREQUEST_SAFETY_LIMIT;
}


/* ============================================================
   MAIN WORKER
   ============================================================ */

export default {

  async fetch(request, env) {

    subrequestCount = 0;

    console.log("==========================================");
    console.log("REPORTLI WEBSITE SCRAPER STARTED");
    console.log("==========================================");

    try {

      /* ================= CORS / OPTIONS ================= */

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      /* ================= ONLY POST ================= */

      if (request.method !== "POST") {
        return jsonResponse(
          { success: false, step: "method_check", error: "Only POST requests are allowed." },
          405
        );
      }

      console.log("STEP 1: POST request received");

      /* ================= READ JSON BODY ================= */

      let body;
      try {
        body = await request.json();
      } catch (error) {
        console.error("STEP 2 FAILED: Invalid JSON", error);
        return jsonResponse(
          { success: false, step: "read_request_body", error: "Request body is not valid JSON." },
          400
        );
      }

      console.log("STEP 2: Request body received");

      /* ================= SUPPORT BOTH NAMING STYLES ================= */

      const applicationId = body.application_id || body.applicationId;
      const websiteUrl = body.website_url || body.websiteUrl;

      console.log("STEP 3: application_id =", applicationId);
      console.log("STEP 3: website_url =", websiteUrl);

      /* ================= VALIDATE APPLICATION ID ================= */

      if (!applicationId || typeof applicationId !== "string" || !applicationId.trim()) {
        return jsonResponse(
          { success: false, step: "validate_input", error: "application_id is missing.", received_body: body },
          400
        );
      }

      /* ================= VALIDATE WEBSITE URL ================= */

      if (!websiteUrl || typeof websiteUrl !== "string" || !websiteUrl.trim()) {
        return jsonResponse(
          { success: false, step: "validate_input", error: "website_url is missing.", received_body: body },
          400
        );
      }

      /* ================= NORMALIZE URL ================= */

      let startUrl;
      try {
        startUrl = new URL(websiteUrl.trim());
      } catch (error) {
        return jsonResponse(
          { success: false, step: "validate_url", error: "Invalid website URL.", website_url: websiteUrl },
          400
        );
      }

      /* ================= ONLY HTTP / HTTPS ================= */

      if (startUrl.protocol !== "https:" && startUrl.protocol !== "http:") {
        return jsonResponse(
          { success: false, step: "validate_url", error: "Only HTTP and HTTPS websites are supported." },
          400
        );
      }

      /* ================= BASIC SSRF PROTECTION ================= */

      if (isBlockedHostname(startUrl.hostname)) {
        return jsonResponse(
          { success: false, step: "validate_url", error: "This hostname is not allowed." },
          400
        );
      }

      console.log("STEP 4: URL validated:", startUrl.href);

      /* ================= CHECK REQUIRED ENV VARS ================= */

      console.log("STEP 5: Checking Worker secrets...");

      if (!env.SUPABASE_URL) {
        return jsonResponse({ success: false, step: "environment", error: "SUPABASE_URL is missing." }, 500);
      }
      if (!env.SUPABASE_SECRET_KEY) {
        return jsonResponse({ success: false, step: "environment", error: "SUPABASE_SECRET_KEY is missing." }, 500);
      }
      if (!env.SARVAM_API_KEY) {
        return jsonResponse({ success: false, step: "environment", error: "SARVAM_API_KEY is missing." }, 500);
      }

      console.log("STEP 5: All required secrets exist");

      /* ================= VERIFY APPLICATION EXISTS ================= */

      console.log("STEP 6: Checking application in Supabase...");

      const applicationCheck = await getApplication(env, applicationId);

      if (!applicationCheck.success) {
        return jsonResponse(
          { success: false, step: "check_application", ...applicationCheck },
          applicationCheck.status || 500
        );
      }

      console.log("STEP 6: Application exists");

      /* ================= DISCOVER WEBSITE PAGES ================= */

      console.log("STEP 7: Discovering internal pages...");

      // pageMap: normalizedUrl -> html (already downloaded, reused below
      // so we don't fetch every page twice)
      const pageMap = await discoverPages(startUrl);
      const pages = Array.from(pageMap.keys());

      console.log("STEP 7: Pages discovered:", pages.length);

      if (!pages.length) {
        return jsonResponse(
          { success: false, step: "discover_pages", error: "Could not find any crawlable pages." },
          422
        );
      }

      /* ================= PROCESS EACH PAGE ================= */

      const results = [];
      let totalFieldsSaved = 0;
      let successfulPages = 0;
      let failedPages = 0;
      let stoppedEarlyDueToLimit = false;

      for (let index = 0; index < pages.length; index++) {

        if (nearSubrequestLimit()) {
          console.log("Stopping early: near Cloudflare subrequest limit.");
          stoppedEarlyDueToLimit = true;
          break;
        }

        const pageUrl = pages[index];

        console.log("------------------------------------------");
        console.log(`PAGE ${index + 1}/${pages.length}`);
        console.log("URL:", pageUrl);

        try {

          /* ============ GET HTML (reuse from discovery if we have it) ============ */

          let html = pageMap.get(pageUrl);

          if (!html) {
            const pageResult = await fetchPage(pageUrl);
            if (!pageResult.success) {
              failedPages++;
              results.push({ url: pageUrl, success: false, step: "fetch_page", error: pageResult.error });
              continue;
            }
            html = pageResult.html;
          }

          console.log("HTML length:", html.length);

          /* ============ EXTRACT TEXT ============ */

          const pageText = extractText(html);
          console.log("Extracted text:", pageText.length, "characters");

          if (!pageText) {
            failedPages++;
            results.push({ url: pageUrl, success: false, step: "extract_text", error: "No readable text found." });
            continue;
          }

          /* ============ LIMIT TEXT ============ */

          const limitedText = pageText.slice(0, MAX_TEXT_CHARS);

          /* ============ SEND TO SARVAM ============ */

          console.log("Sending page to Sarvam...");

          const aiResult = await extractBusinessDataWithSarvam(env, pageUrl, limitedText);

          if (!aiResult.success) {
            failedPages++;
            results.push({ url: pageUrl, success: false, step: "sarvam", error: aiResult.error });
            continue;
          }

          console.log("Sarvam fields received:", aiResult.fields.length);

          /* ============ SAVE FIELDS TO SUPABASE ============ */

          let pageFieldsSaved = 0;
          const fieldErrors = [];

          for (const extractedField of aiResult.fields) {

            const fieldName = normalizeFieldName(extractedField.field);

            if (!fieldName) {
              console.log("Skipping empty field");
              continue;
            }

            const data = extractedField.data;

            if (data === undefined || data === null) {
              console.log("Skipping empty data for:", fieldName);
              continue;
            }

            const saveResult = await saveBusinessData(env, {
              application_id: applicationId,
              field: fieldName,
              data: data,
              source_url: pageUrl,
              updated_at: new Date().toISOString()
            });

            if (!saveResult.success) {
              console.error("Supabase save failed:", fieldName, saveResult.error);
              // FIX: surface this instead of silently dropping it
              fieldErrors.push({ field: fieldName, error: saveResult.error });
              continue;
            }

            pageFieldsSaved++;
            totalFieldsSaved++;
          }

          /* ============ PAGE RESULT ============ */

          // FIX: only count a page as fully successful if at least
          // one field actually saved (or there were simply no fields
          // to save). A page where every save failed is not a success.
          const pageHadFieldsToSave = aiResult.fields.length > 0;
          const pageIsSuccess = !pageHadFieldsToSave || pageFieldsSaved > 0 || fieldErrors.length === 0;

          if (pageIsSuccess) {
            successfulPages++;
          } else {
            failedPages++;
          }

          results.push({
            url: pageUrl,
            success: pageIsSuccess,
            fields_found: aiResult.fields.length,
            fields_saved: pageFieldsSaved,
            field_errors: fieldErrors.length ? fieldErrors : undefined
          });

          console.log(`PAGE ${index + 1} COMPLETE`);

        } catch (pageError) {
          failedPages++;
          console.error("PAGE ERROR:", pageError);
          results.push({
            url: pageUrl,
            success: false,
            step: "page_processing",
            error: pageError?.message || String(pageError)
          });
        }
      }

      /* ================= FINAL RESPONSE ================= */

      console.log("==========================================");
      console.log("SCRAPER FINISHED");
      console.log("Successful pages:", successfulPages);
      console.log("Failed pages:", failedPages);
      console.log("Total fields saved:", totalFieldsSaved);
      console.log("==========================================");

      return jsonResponse(
        {
          success: true,
          message: "Website scraping completed.",
          application_id: applicationId,
          website_url: startUrl.href,
          pages_discovered: pages.length,
          pages_successful: successfulPages,
          pages_failed: failedPages,
          fields_saved: totalFieldsSaved,
          stopped_early_due_to_subrequest_limit: stoppedEarlyDueToLimit,
          note:
            totalFieldsSaved === 0
              ? "No fields were saved. Check results[].field_errors and results[].error below. " +
                "A common cause is a missing unique constraint on business_data(application_id, field) " +
                "required for the upsert's on_conflict clause."
              : undefined,
          results: results
        },
        200
      );

    } catch (error) {
      console.error("GLOBAL WORKER ERROR:", error);
      return jsonResponse(
        { success: false, step: "global_error", error: error?.message || String(error), stack: error?.stack || null },
        500
      );
    }
  }
};


/* ============================================================
   GET APPLICATION FROM SUPABASE
   ============================================================ */

async function getApplication(env, applicationId) {
  try {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/applications`);
    url.searchParams.set("id", `eq.${applicationId}`);
    url.searchParams.set("select", "id");

    trackSubrequest();
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "apikey": env.SUPABASE_SECRET_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SECRET_KEY}`
      }
    });

    const text = await response.text();
    console.log("Supabase application check:", response.status);

    if (!response.ok) {
      return { success: false, status: 500, error: `Supabase application check failed: ${text}` };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { success: false, status: 500, error: "Supabase returned invalid JSON." };
    }

    if (!Array.isArray(data) || data.length === 0) {
      return {
        success: false,
        status: 404,
        error: "The application_id does not exist in the applications table.",
        application_id: applicationId
      };
    }

    return { success: true };

  } catch (error) {
    return { success: false, status: 500, error: error?.message || String(error) };
  }
}


/* ============================================================
   DISCOVER INTERNAL PAGES
   Returns a Map of normalizedUrl -> html so the main loop
   doesn't need to re-fetch pages it already downloaded here.
   ============================================================ */

async function discoverPages(startUrl) {

  const pageMap = new Map(); // url -> html
  const queue = [];

  const normalizedStart = normalizeUrl(startUrl.href);
  queue.push(normalizedStart);

  const visited = new Set([normalizedStart]);

  while (queue.length > 0 && pageMap.size < MAX_PAGES) {

    if (nearSubrequestLimit()) {
      console.log("Stopping discovery early: near subrequest limit.");
      break;
    }

    const currentUrl = queue.shift();

    try {
      console.log("Discovering:", currentUrl);

      trackSubrequest();
      const response = await fetchWithTimeout(
        currentUrl,
        {
          method: "GET",
          headers: {
            "User-Agent": "ReportliAI-WebsiteCrawler/1.0",
            "Accept": "text/html,application/xhtml+xml"
          }
        },
        FETCH_TIMEOUT_MS
      );

      if (!response.ok) {
        console.log("Skipping page:", currentUrl, "HTTP", response.status);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";

      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        continue;
      }

      const html = await response.text();

      if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
        console.log("Page too large during discovery, will skip content but keep link scan:", currentUrl);
      } else {
        pageMap.set(currentUrl, html);
      }

      const links = extractLinks(html, new URL(currentUrl));

      for (const link of links) {

        if (pageMap.size + queue.length >= MAX_PAGES) break;
        if (visited.has(link)) continue;
        if (!sameHostname(new URL(currentUrl), new URL(link))) continue;

        visited.add(link);
        queue.push(link);
      }

    } catch (error) {
      console.log("Discovery error:", currentUrl, error?.message || String(error));
    }
  }

  return pageMap;
}


/* ============================================================
   EXTRACT LINKS FROM HTML
   ============================================================ */

function extractLinks(html, currentUrl) {

  const links = new Set();
  const regex = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {

    const href = match[1];
    if (!href) continue;

    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    ) {
      continue;
    }

    try {
      const absoluteUrl = new URL(href, currentUrl);

      if (absoluteUrl.protocol !== "http:" && absoluteUrl.protocol !== "https:") continue;
      if (!sameHostname(currentUrl, absoluteUrl)) continue;
      if (isLikelyFile(absoluteUrl.pathname)) continue;
      if (isBlockedHostname(absoluteUrl.hostname)) continue;

      links.add(normalizeUrl(absoluteUrl.href));

    } catch {
      // Ignore malformed links.
    }
  }

  return Array.from(links);
}


/* ============================================================
   FETCH ONE PAGE (fallback path, only used if a discovered
   URL wasn't already cached from discoverPages)
   ============================================================ */

async function fetchPage(pageUrl) {
  try {
    trackSubrequest();
    const response = await fetchWithTimeout(
      pageUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "ReportliAI-WebsiteCrawler/1.0",
          "Accept": "text/html,application/xhtml+xml"
        }
      },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
      return { success: false, error: `Website returned HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return { success: false, error: `Not an HTML page. Content-Type: ${contentType}` };
    }

    const html = await response.text();

    if (!html) {
      return { success: false, error: "Empty HTML response." };
    }

    if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
      return { success: false, error: "HTML page is too large." };
    }

    return { success: true, html: html };

  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}


/* ============================================================
   EXTRACT READABLE TEXT
   ============================================================ */

function extractText(html) {

  let text = html;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");

  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, " ");

  return text.trim();
}


/* ============================================================
   SARVAM AI
   ============================================================ */

async function extractBusinessDataWithSarvam(env, pageUrl, pageText) {

  const systemPrompt = `
You are a website information extraction system for Reportli AI.

Your job is to read ONE webpage and extract useful business information.

IMPORTANT RULES:

1. Only extract information that is actually present on the webpage.
2. Do not invent information.
3. Do not guess missing values.
4. Return an empty fields array if there is no useful business information.
5. Use short, reusable field names.
6. The field name should describe the information.
7. Keep the data useful for AI employees such as:
   - AI receptionist
   - WhatsApp agent
   - Gmail agent
   - sales agent
   - customer support agent
   - appointment agent
8. Information can include:
   - business_name, business_description, address, phone, email,
     opening_hours, services, products, pricing, faq, about,
     contact_information, appointment_information, cancellation_policy,
     refund_policy, privacy_policy, terms, payment_information,
     delivery_information, service_area, social_links
9. Do not create fields for navigation menus, cookie banners, tracking
   text, footer copyright text, or unrelated technical content.
10. If a value contains multiple items, return an array when appropriate.
11. Preserve important factual wording.
12. Never return markdown.
13. Respond with ONLY a raw JSON object of the exact shape:
    {"fields":[{"field":"string","data":"..."}]}
    No prose, no code fences, no explanation before or after it.
`;

  const userPrompt = `
SOURCE URL:
${pageUrl}

WEBPAGE TEXT:
${pageText}
`;

  const baseRequestBody = {
    model: SARVAM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 3000
  };

  const strictSchemaRequestBody = {
    ...baseRequestBody,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "business_information",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  field: { type: "string" },
                  data: {}
                },
                required: ["field", "data"]
              }
            }
          },
          required: ["fields"]
        }
      }
    }
  };

  // First attempt: strict json_schema mode.
  let result = await callSarvam(env, strictSchemaRequestBody);

  // FIX: if the strict schema mode isn't supported / rejected by the
  // API (this can happen depending on model/endpoint availability),
  // fall back to a plain request and rely on the prompt + manual
  // JSON parsing instead of failing the whole page.
  if (!result.success) {
    console.log("Sarvam strict json_schema call failed, retrying without response_format:", result.error);
    result = await callSarvam(env, baseRequestBody);
  }

  return result;
}

async function callSarvam(env, requestBody) {
  try {
    console.log("Calling Sarvam:", SARVAM_MODEL);

    trackSubrequest();
    const response = await fetch(SARVAM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": env.SARVAM_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();
    console.log("Sarvam status:", response.status);

    if (!response.ok) {
      console.error("Sarvam error:", responseText);
      return { success: false, error: `Sarvam API returned ${response.status}: ${responseText}` };
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      return { success: false, error: "Sarvam returned invalid JSON." };
    }

    const content = result?.choices?.[0]?.message?.content;

    if (!content) {
      return { success: false, error: "Sarvam response did not contain message.content." };
    }

    const parsed = extractJsonFromModelContent(content);

    if (!parsed || !Array.isArray(parsed.fields)) {
      console.error("Could not parse Sarvam content:", content);
      return { success: false, error: "Sarvam JSON did not contain a fields array." };
    }

    return { success: true, fields: parsed.fields };

  } catch (error) {
    console.error("Sarvam request error:", error);
    return { success: false, error: error?.message || String(error) };
  }
}

// FIX: models sometimes wrap JSON in ```json fences or add stray
// text even when asked not to. Try a direct parse first, then fall
// back to extracting the first {...} block.
function extractJsonFromModelContent(content) {
  if (typeof content !== "object" || content === null) {
    if (typeof content !== "string") return null;

    try {
      return JSON.parse(content);
    } catch {
      // fall through to fence/brace extraction
    }

    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // fall through
      }
    }

    const braceStart = content.indexOf("{");
    const braceEnd = content.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(content.slice(braceStart, braceEnd + 1));
      } catch {
        return null;
      }
    }

    return null;
  }

  return content;
}


/* ============================================================
   SAVE BUSINESS DATA
   ============================================================ */

async function saveBusinessData(env, data) {
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/business_data?on_conflict=application_id,field`;

    trackSubrequest();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_SECRET_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(data)
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("SUPABASE BUSINESS_DATA ERROR:", response.status, responseText);

      let hint = "";
      if (responseText.includes("42P10") || responseText.toLowerCase().includes("no unique or exclusion constraint")) {
        hint =
          " HINT: business_data is missing a unique constraint on (application_id, field). " +
          "Run: alter table business_data add constraint business_data_app_field_unique unique (application_id, field);";
      }

      return { success: false, error: `Supabase returned ${response.status}: ${responseText}${hint}` };
    }

    console.log("Saved field:", data.field);
    return { success: true };

  } catch (error) {
    console.error("Supabase save exception:", error);
    return { success: false, error: error?.message || String(error) };
  }
}


/* ============================================================
   NORMALIZE FIELD NAME
   ============================================================ */

function normalizeFieldName(field) {
  if (typeof field !== "string") return null;

  let value = field.trim().toLowerCase();
  value = value.replace(/[\s-]+/g, "_");
  value = value.replace(/[^a-z0-9_]/g, "");
  value = value.slice(0, 100);

  return value || null;
}


/* ============================================================
   URL NORMALIZATION
   ============================================================ */

function normalizeUrl(url) {
  const parsed = new URL(url);

  parsed.hash = "";

  const trackingParameters = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

  for (const parameter of trackingParameters) {
    parsed.searchParams.delete(parameter);
  }

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
  }

  return parsed.href;
}


/* ============================================================
   SAME HOSTNAME
   ============================================================ */

function sameHostname(first, second) {
  return first.hostname.toLowerCase() === second.hostname.toLowerCase();
}


/* ============================================================
   IGNORE FILES
   ============================================================ */

function isLikelyFile(pathname) {
  return /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|zip|rar|mp4|mp3|wav|avi|mov|doc|docx|xls|xlsx|ppt|pptx)$/i.test(pathname);
}


/* ============================================================
   BASIC BLOCKED HOSTNAME CHECK (SSRF protection)
   ============================================================ */

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().trim();

  const blocked = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "metadata.google.internal",
    "metadata.google",
    // FIX: cloud metadata endpoint (AWS/GCP/Azure) reachable via link-local
    "169.254.169.254"
  ];

  if (blocked.includes(host)) return true;

  // IPv4 private / link-local ranges
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host) // FIX: link-local (covers cloud metadata range)
  ) {
    return true;
  }

  // FIX: IPv6 loopback / unique-local / link-local
  if (
    host === "::1" ||
    host.startsWith("fc") || // fc00::/7 unique local
    host.startsWith("fd") ||
    host.startsWith("fe80") // link-local
  ) {
    return true;
  }

  return false;
}


/* ============================================================
   FETCH WITH TIMEOUT
   ============================================================ */

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


/* ============================================================
   DECODE BASIC HTML ENTITIES
   ============================================================ */

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}


/* ============================================================
   JSON RESPONSE
   ============================================================ */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}


/* ============================================================
   CORS
   ============================================================ */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
