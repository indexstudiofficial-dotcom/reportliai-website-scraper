/**
 * ============================================================
 * REPORTLI AI - WEBSITE SCRAPER WORKER
 * ============================================================
 *
 * INPUT:
 *
 * {
 *   "application_id": "app-1790254969447",
 *   "domain": "https://drjohnysdentalclinicpalakkad.com"
 * }
 *
 * ALSO ACCEPTS:
 *
 * {
 *   "applicationId": "...",
 *   "websiteUrl": "..."
 * }
 *
 * OR:
 *
 * {
 *   "application_id": "...",
 *   "website_url": "..."
 * }
 *
 *
 * FLOW:
 *
 * SaaS
 *   ↓
 * Worker
 *   ↓
 * Validate application
 *   ↓
 * Discover internal pages
 *   ↓
 * Fetch ONE page
 *   ↓
 * Extract readable text
 *   ↓
 * Send ONE page to Sarvam
 *   ↓
 * Receive structured business fields
 *   ↓
 * Save to Supabase business_data
 *   ↓
 * Next page
 *
 * ============================================================
 */


/* ============================================================
   CONFIGURATION
   ============================================================ */

// Maximum number of HTML pages to crawl per request.
//
// Keep this conservative because every page requires:
// - Website fetch
// - Sarvam API call
// - Supabase save(s)
//
// For a production queue-based crawler, this can be increased.
const MAX_PAGES = 20;


// Maximum HTML size accepted for a page.
const MAX_HTML_BYTES = 2 * 1024 * 1024;


// Maximum readable text sent to Sarvam for ONE page.
const MAX_TEXT_CHARS = 30000;


// Website request timeout.
const FETCH_TIMEOUT_MS = 15000;


// Sarvam API.
const SARVAM_API_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";


// Cloudflare subrequest safety.
//
// This is our own approximate counter.
// We stop before getting too close to the limit.
const SUBREQUEST_SAFETY_LIMIT = 45;


// Runtime counter.
let subrequestCount = 0;


/* ============================================================
   MAIN WORKER
   ============================================================ */

export default {

  async fetch(request, env) {

    // Reset counter for every request.
    subrequestCount = 0;

    console.log("==========================================");
    console.log("REPORTLI AI WEBSITE SCRAPER");
    console.log("==========================================");

    try {

      /* ======================================================
         CORS
         ====================================================== */

      if (request.method === "OPTIONS") {

        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });

      }


      /* ======================================================
         ONLY POST
         ====================================================== */

      if (request.method !== "POST") {

        return jsonResponse(
          {
            success: false,
            step: "method_check",
            error: "Only POST requests are allowed."
          },
          405
        );

      }


      console.log("STEP 1: POST request received");


      /* ======================================================
         READ JSON BODY
         ====================================================== */

      let body;

      try {

        body = await request.json();

      } catch (error) {

        console.error(
          "Invalid JSON:",
          error
        );

        return jsonResponse(
          {
            success: false,
            step: "read_request_body",
            error: "Request body is not valid JSON."
          },
          400
        );

      }


      console.log(
        "REQUEST BODY:",
        JSON.stringify(body)
      );


      /* ======================================================
         GET APPLICATION ID
         ====================================================== */

      const applicationId =
        body.application_id ||
        body.applicationId;


      /* ======================================================
         GET WEBSITE URL
         ======================================================

         IMPORTANT FIX:

         Your frontend sends:

         {
           "domain": "https://example.com"
         }

         Therefore we now support:

         - website_url
         - websiteUrl
         - domain

         ====================================================== */

      const websiteUrl =
        body.website_url ||
        body.websiteUrl ||
        body.domain;


      console.log(
        "APPLICATION ID:",
        applicationId
      );

      console.log(
        "WEBSITE URL:",
        websiteUrl
      );


      /* ======================================================
         VALIDATE APPLICATION ID
         ====================================================== */

      if (
        !applicationId ||
        typeof applicationId !== "string" ||
        !applicationId.trim()
      ) {

        return jsonResponse(
          {
            success: false,
            step: "validate_input",
            error: "application_id is missing.",
            received_body: body
          },
          400
        );

      }


      /* ======================================================
         VALIDATE WEBSITE URL
         ====================================================== */

      if (
        !websiteUrl ||
        typeof websiteUrl !== "string" ||
        !websiteUrl.trim()
      ) {

        return jsonResponse(
          {
            success: false,
            step: "validate_input",
            error: "Website URL is missing. Send website_url, websiteUrl, or domain.",
            received_body: body
          },
          400
        );

      }


      /* ======================================================
         CHECK ENVIRONMENT
         ====================================================== */

      if (!env.SUPABASE_URL) {

        return jsonResponse(
          {
            success: false,
            step: "environment",
            error: "SUPABASE_URL is missing."
          },
          500
        );

      }


      if (!env.SUPABASE_SECRET_KEY) {

        return jsonResponse(
          {
            success: false,
            step: "environment",
            error: "SUPABASE_SECRET_KEY is missing."
          },
          500
        );

      }


      if (!env.SARVAM_API_KEY) {

        return jsonResponse(
          {
            success: false,
            step: "environment",
            error: "SARVAM_API_KEY is missing."
          },
          500
        );

      }


      /* ======================================================
         PARSE URL
         ====================================================== */

      let startUrl;

      try {

        startUrl =
          new URL(
            websiteUrl.trim()
          );

      } catch (error) {

        return jsonResponse(
          {
            success: false,
            step: "validate_url",
            error: "Invalid website URL.",
            website_url: websiteUrl
          },
          400
        );

      }


      /* ======================================================
         HTTP / HTTPS ONLY
         ====================================================== */

      if (
        startUrl.protocol !== "http:" &&
        startUrl.protocol !== "https:"
      ) {

        return jsonResponse(
          {
            success: false,
            step: "validate_url",
            error:
              "Only HTTP and HTTPS websites are supported."
          },
          400
        );

      }


      /* ======================================================
         SSRF PROTECTION
         ====================================================== */

      if (
        isBlockedHostname(
          startUrl.hostname
        )
      ) {

        return jsonResponse(
          {
            success: false,
            step: "validate_url",
            error:
              "This hostname is not allowed."
          },
          400
        );

      }


      console.log(
        "VALIDATED WEBSITE:",
        startUrl.href
      );


      /* ======================================================
         VERIFY APPLICATION EXISTS
         ====================================================== */

      console.log(
        "STEP 2: Checking application..."
      );


      const applicationCheck =
        await getApplication(
          env,
          applicationId
        );


      if (!applicationCheck.success) {

        return jsonResponse(
          {
            success: false,
            step: "check_application",
            ...applicationCheck
          },
          applicationCheck.status || 500
        );

      }


      console.log(
        "Application exists."
      );


      /* ======================================================
         DISCOVER INTERNAL PAGES
         ====================================================== */

      console.log(
        "STEP 3: Discovering website pages..."
      );


      const pageMap =
        await discoverPages(
          startUrl
        );


      const pages =
        Array.from(
          pageMap.keys()
        );


      console.log(
        "PAGES DISCOVERED:",
        pages.length
      );


      if (!pages.length) {

        return jsonResponse(
          {
            success: false,
            step: "discover_pages",
            error:
              "Could not find any crawlable HTML pages."
          },
          422
        );

      }


      /* ======================================================
         PROCESS PAGES
         ====================================================== */

      const results = [];

      let totalFieldsSaved = 0;

      let successfulPages = 0;

      let failedPages = 0;

      let stoppedEarly =
        false;


      for (
        let index = 0;
        index < pages.length;
        index++
      ) {


        /* ====================================================
           CHECK SUBREQUEST SAFETY
           ==================================================== */

        if (
          nearSubrequestLimit()
        ) {

          console.log(
            "Stopping because subrequest safety limit was reached."
          );

          stoppedEarly =
            true;

          break;

        }


        const pageUrl =
          pages[index];


        console.log(
          "------------------------------------------"
        );

        console.log(
          `PROCESSING PAGE ${index + 1}/${pages.length}`
        );

        console.log(
          pageUrl
        );


        try {


          /* ==================================================
             GET CACHED HTML
             ================================================== */

          const html =
            pageMap.get(
              pageUrl
            );


          if (!html) {

            failedPages++;

            results.push({
              url: pageUrl,
              success: false,
              step: "fetch_page",
              error:
                "HTML was not available."
            });

            continue;

          }


          /* ==================================================
             EXTRACT TEXT
             ================================================== */

          const pageText =
            extractText(
              html
            );


          console.log(
            "TEXT LENGTH:",
            pageText.length
          );


          if (!pageText) {

            failedPages++;

            results.push({
              url: pageUrl,
              success: false,
              step: "extract_text",
              error:
                "No readable text found."
            });

            continue;

          }


          /* ==================================================
             LIMIT TEXT
             ================================================== */

          const limitedText =
            pageText.slice(
              0,
              MAX_TEXT_CHARS
            );


          /* ==================================================
             SEND ONE PAGE TO SARVAM
             ================================================== */

          console.log(
            "Sending page to Sarvam..."
          );


          const aiResult =
            await extractBusinessDataWithSarvam(
              env,
              pageUrl,
              limitedText
            );


          if (!aiResult.success) {

            failedPages++;

            results.push({
              url: pageUrl,
              success: false,
              step: "sarvam",
              error:
                aiResult.error
            });

            continue;

          }


          console.log(
            "SARVAM FIELDS:",
            aiResult.fields.length
          );


          /* ==================================================
             SAVE FIELDS
             ================================================== */

          let pageFieldsSaved = 0;

          const fieldErrors = [];


          for (
            const extractedField
            of aiResult.fields
          ) {


            /* ==============================================
               NORMALIZE FIELD NAME
               ============================================== */

            const fieldName =
              normalizeFieldName(
                extractedField.field
              );


            if (!fieldName) {

              continue;

            }


            /* ==============================================
               GET DATA
               ============================================== */

            const data =
              extractedField.data;


            if (
              data === undefined ||
              data === null
            ) {

              continue;

            }


            /* ==============================================
               SAVE TO SUPABASE
               ============================================== */

            const saveResult =
              await saveBusinessData(
                env,
                {
                  application_id:
                    applicationId,

                  field:
                    fieldName,

                  data:
                    data,

                  source_url:
                    pageUrl,

                  updated_at:
                    new Date().toISOString()
                }
              );


            if (
              !saveResult.success
            ) {

              console.error(
                "FIELD SAVE FAILED:",
                fieldName,
                saveResult.error
              );

              fieldErrors.push({
                field:
                  fieldName,

                error:
                  saveResult.error
              });

              continue;

            }


            pageFieldsSaved++;

            totalFieldsSaved++;


            console.log(
              "SAVED FIELD:",
              fieldName
            );

          }


          /* ==================================================
             PAGE RESULT
             ================================================== */

          const pageSuccess =
            fieldErrors.length === 0;


          if (pageSuccess) {

            successfulPages++;

          } else {

            failedPages++;

          }


          results.push({
            url:
              pageUrl,

            success:
              pageSuccess,

            fields_found:
              aiResult.fields.length,

            fields_saved:
              pageFieldsSaved,

            field_errors:
              fieldErrors
          });


          console.log(
            `PAGE ${index + 1} FINISHED`
          );


        } catch (pageError) {


          failedPages++;


          console.error(
            "PAGE ERROR:",
            pageError
          );


          results.push({
            url:
              pageUrl,

            success:
              false,

            step:
              "page_processing",

            error:
              pageError?.message ||
              String(pageError)
          });

        }

      }


      /* ======================================================
         FINAL RESPONSE
         ====================================================== */

      console.log(
        "=========================================="
      );

      console.log(
        "SCRAPER FINISHED"
      );

      console.log(
        "Pages discovered:",
        pages.length
      );

      console.log(
        "Pages successful:",
        successfulPages
      );

      console.log(
        "Pages failed:",
        failedPages
      );

      console.log(
        "Fields saved:",
        totalFieldsSaved
      );

      console.log(
        "=========================================="
      );


      return jsonResponse(
        {
          success:
            true,

          message:
            "Website scraping completed.",

          application_id:
            applicationId,

          website_url:
            startUrl.href,

          pages_discovered:
            pages.length,

          pages_processed:
            successfulPages +
            failedPages,

          pages_successful:
            successfulPages,

          pages_failed:
            failedPages,

          fields_saved:
            totalFieldsSaved,

          stopped_early:
            stoppedEarly,

          results:
            results
        },
        200
      );


    } catch (error) {


      /* ======================================================
         GLOBAL ERROR
         ====================================================== */

      console.error(
        "GLOBAL WORKER ERROR:",
        error
      );


      return jsonResponse(
        {
          success:
            false,

          step:
            "global_error",

          error:
            error?.message ||
            String(error),

          stack:
            error?.stack ||
            null
        },
        500
      );

    }

  }

};


/* ============================================================
   GET APPLICATION
   ============================================================ */

async function getApplication(
  env,
  applicationId
) {

  try {

    const url =
      new URL(
        `${env.SUPABASE_URL}/rest/v1/applications`
      );


    url.searchParams.set(
      "id",
      `eq.${applicationId}`
    );


    url.searchParams.set(
      "select",
      "id"
    );


    trackSubrequest();


    const response =
      await fetch(
        url.toString(),
        {
          method:
            "GET",

          headers: {
            "apikey":
              env.SUPABASE_SECRET_KEY,

            "Authorization":
              `Bearer ${env.SUPABASE_SECRET_KEY}`
          }
        }
      );


    const responseText =
      await response.text();


    console.log(
      "APPLICATION CHECK STATUS:",
      response.status
    );


    if (
      !response.ok
    ) {

      return {
        success:
          false,

        status:
          500,

        error:
          `Supabase application check failed: ${responseText}`
      };

    }


    let data;


    try {

      data =
        JSON.parse(
          responseText
        );

    } catch {

      return {
        success:
          false,

        status:
          500,

        error:
          "Supabase returned invalid JSON."
      };

    }


    if (
      !Array.isArray(data) ||
      data.length === 0
    ) {

      return {
        success:
          false,

        status:
          404,

        error:
          "The application_id does not exist in the applications table.",

        application_id:
          applicationId
      };

    }


    return {
      success:
        true
    };


  } catch (error) {

    return {
      success:
        false,

      status:
        500,

      error:
        error?.message ||
        String(error)
    };

  }

}


/* ============================================================
   DISCOVER INTERNAL PAGES
   ============================================================ */

async function discoverPages(
  startUrl
) {

  const pageMap =
    new Map();


  const queue =
    [];


  const start =
    normalizeUrl(
      startUrl.href
    );


  queue.push(
    start
  );


  const visited =
    new Set();


  visited.add(
    start
  );


  while (
    queue.length > 0 &&
    pageMap.size < MAX_PAGES
  ) {


    /* ========================================================
       SUBREQUEST SAFETY
       ======================================================== */

    if (
      nearSubrequestLimit()
    ) {

      console.log(
        "Discovery stopped because of subrequest safety limit."
      );

      break;

    }


    const currentUrl =
      queue.shift();


    try {


      console.log(
        "DISCOVERING:",
        currentUrl
      );


      /* ======================================================
         FETCH PAGE
         ====================================================== */

      trackSubrequest();


      const response =
        await fetchWithTimeout(
          currentUrl,
          {
            method:
              "GET",

            headers: {
              "User-Agent":
                "ReportliAI-WebsiteCrawler/1.0",

              "Accept":
                "text/html,application/xhtml+xml"
            }
          },
          FETCH_TIMEOUT_MS
        );


      if (
        !response.ok
      ) {

        console.log(
          "HTTP ERROR:",
          response.status,
          currentUrl
        );

        continue;

      }


      /* ======================================================
         CONTENT TYPE
         ====================================================== */

      const contentType =
        response.headers.get(
          "content-type"
        ) || "";


      if (
        !contentType.includes(
          "text/html"
        ) &&
        !contentType.includes(
          "application/xhtml+xml"
        )
      ) {

        continue;

      }


      /* ======================================================
         READ HTML
         ====================================================== */

      const html =
        await response.text();


      if (!html) {

        continue;

      }


      /* ======================================================
         CHECK HTML SIZE
         ====================================================== */

      const htmlBytes =
        new TextEncoder()
          .encode(html)
          .length;


      if (
        htmlBytes <=
        MAX_HTML_BYTES
      ) {

        pageMap.set(
          currentUrl,
          html
        );

      }


      /* ======================================================
         FIND INTERNAL LINKS
         ====================================================== */

      const links =
        extractLinks(
          html,
          new URL(currentUrl)
        );


      for (
        const link
        of links
      ) {


        if (
          pageMap.size +
          queue.length >=
          MAX_PAGES
        ) {

          break;

        }


        if (
          visited.has(link)
        ) {

          continue;

        }


        visited.add(
          link
        );


        queue.push(
          link
        );

      }


    } catch (error) {


      console.error(
        "DISCOVERY ERROR:",
        currentUrl,
        error?.message ||
        String(error)
      );

    }

  }


  return pageMap;

}


/* ============================================================
   EXTRACT INTERNAL LINKS
   ============================================================ */

function extractLinks(
  html,
  currentUrl
) {

  const links =
    new Set();


  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;


  let match;


  while (
    (match = regex.exec(html))
    !== null
  ) {


    const href =
      match[1];


    if (!href) {

      continue;

    }


    /* ========================================================
       IGNORE SPECIAL LINKS
       ======================================================== */

    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    ) {

      continue;

    }


    try {


      const absoluteUrl =
        new URL(
          href,
          currentUrl
        );


      /* ======================================================
         HTTP / HTTPS
         ====================================================== */

      if (
        absoluteUrl.protocol !==
          "http:" &&
        absoluteUrl.protocol !==
          "https:"
      ) {

        continue;

      }


      /* ======================================================
         SAME WEBSITE ONLY
         ====================================================== */

      if (
        !sameHostname(
          currentUrl,
          absoluteUrl
        )
      ) {

        continue;

      }


      /* ======================================================
         BLOCKED HOSTS
         ====================================================== */

      if (
        isBlockedHostname(
          absoluteUrl.hostname
        )
      ) {

        continue;

      }


      /* ======================================================
         IGNORE FILES
         ====================================================== */

      if (
        isLikelyFile(
          absoluteUrl.pathname
        )
      ) {

        continue;

      }


      /* ======================================================
         NORMALIZE
         ====================================================== */

      const normalized =
        normalizeUrl(
          absoluteUrl.href
        );


      links.add(
        normalized
      );


    } catch {

      // Ignore malformed URLs.

    }

  }


  return Array.from(
    links
  );

}


/* ============================================================
   EXTRACT READABLE TEXT
   ============================================================ */

function extractText(
  html
) {

  let text =
    html;


  /* ==========================================================
     REMOVE SCRIPT
     ========================================================== */

  text =
    text.replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    );


  /* ==========================================================
     REMOVE STYLE
     ========================================================== */

  text =
    text.replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    );


  /* ==========================================================
     REMOVE NOSCRIPT
     ========================================================== */

  text =
    text.replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      " "
    );


  /* ==========================================================
     REMOVE SVG
     ========================================================== */

  text =
    text.replace(
      /<svg[\s\S]*?<\/svg>/gi,
      " "
    );


  /* ==========================================================
     REMOVE HTML TAGS
     ========================================================== */

  text =
    text.replace(
      /<[^>]+>/g,
      " "
    );


  /* ==========================================================
     DECODE ENTITIES
     ========================================================== */

  text =
    decodeHtmlEntities(
      text
    );


  /* ==========================================================
     CLEAN WHITESPACE
     ========================================================== */

  text =
    text.replace(
      /\s+/g,
      " "
    );


  return text.trim();

}


/* ============================================================
   SEND ONE PAGE TO SARVAM
   ============================================================ */

async function extractBusinessDataWithSarvam(
  env,
  pageUrl,
  pageText
) {


  const systemPrompt = `

You are a website information extraction system for Reportli AI.

You receive ONE webpage at a time.

Your job is to extract useful factual business information
from that webpage.

IMPORTANT RULES:

1. Only extract information that is actually present.
2. Never invent information.
3. Never guess missing information.
4. If useful business information is not present, return:
   {"fields":[]}
5. Use short reusable field names.
6. Field names must describe the information.
7. Extract information useful for AI employees.
8. Useful information includes:
   - business_name
   - business_description
   - address
   - phone
   - email
   - opening_hours
   - services
   - products
   - pricing
   - faq
   - about
   - contact_information
   - appointment_information
   - cancellation_policy
   - refund_policy
   - privacy_policy
   - terms
   - payment_information
   - delivery_information
   - service_area
   - social_links
   - doctors
   - treatments
   - facilities
   - insurance
   - emergency_information
9. Do not extract:
   - navigation menus
   - cookie banners
   - tracking information
   - unrelated technical information
   - footer copyright text
10. If there are multiple services, products,
    doctors, FAQs, etc., use arrays when appropriate.
11. Preserve important factual information.
12. Do not use markdown.
13. Return ONLY JSON.
14. The exact response format is:

{
  "fields": [
    {
      "field": "business_name",
      "data": "Example Business"
    }
  ]
}

15. No explanation.
16. No code fences.
17. No text before or after the JSON.

`;


  const userPrompt = `

SOURCE URL:
${pageUrl}

WEBPAGE TEXT:
${pageText}

`;


  const baseRequestBody = {

    model:
      SARVAM_MODEL,

    messages: [

      {
        role:
          "system",

        content:
          systemPrompt
      },

      {
        role:
          "user",

        content:
          userPrompt
      }

    ],

    temperature:
      0,

    max_tokens:
      3000

  };


  /* ==========================================================
     FIRST TRY: JSON SCHEMA
     ========================================================== */

  const strictRequestBody = {

    ...baseRequestBody,

    response_format: {

      type:
        "json_schema",

      json_schema: {

        name:
          "business_information",

        strict:
          true,

        schema: {

          type:
            "object",

          additionalProperties:
            false,

          properties: {

            fields: {

              type:
                "array",

              items: {

                type:
                  "object",

                additionalProperties:
                  false,

                properties: {

                  field: {
                    type:
                      "string"
                  },

                  data: {}

                },

                required: [
                  "field",
                  "data"
                ]

              }

            }

          },

          required: [
            "fields"
          ]

        }

      }

    }

  };


  let result =
    await callSarvam(
      env,
      strictRequestBody
    );


  /* ==========================================================
     FALLBACK WITHOUT JSON SCHEMA
     ========================================================== */

  if (
    !result.success
  ) {

    console.log(
      "Sarvam JSON schema request failed."
    );

    console.log(
      "Retrying without response_format..."
    );


    result =
      await callSarvam(
        env,
        baseRequestBody
      );

  }


  return result;

}


/* ============================================================
   SARVAM REQUEST
   ============================================================ */

async function callSarvam(
  env,
  requestBody
) {

  try {


    /* ========================================================
       CHECK SUBREQUEST LIMIT
       ======================================================== */

    if (
      nearSubrequestLimit()
    ) {

      return {
        success:
          false,

        error:
          "Cloudflare subrequest safety limit reached."
      };

    }


    trackSubrequest();


    /* ========================================================
       CALL SARVAM
       ======================================================== */

    const response =
      await fetch(
        SARVAM_API_URL,
        {
          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "api-subscription-key":
              env.SARVAM_API_KEY

          },

          body:
            JSON.stringify(
              requestBody
            )

        }
      );


    const responseText =
      await response.text();


    console.log(
      "SARVAM STATUS:",
      response.status
    );


    /* ========================================================
       API ERROR
       ======================================================== */

    if (
      !response.ok
    ) {

      console.error(
        "SARVAM ERROR:",
        responseText
      );


      return {

        success:
          false,

        error:
          `Sarvam API returned ${response.status}: ${responseText}`

      };

    }


    /* ========================================================
       PARSE SARVAM RESPONSE
       ======================================================== */

    let result;


    try {

      result =
        JSON.parse(
          responseText
        );

    } catch {

      return {

        success:
          false,

        error:
          "Sarvam returned invalid JSON."

      };

    }


    /* ========================================================
       GET MODEL CONTENT
       ======================================================== */

    const content =
      result
        ?.choices?.[0]
        ?.message
        ?.content;


    if (!content) {

      return {

        success:
          false,

        error:
          "Sarvam response did not contain message.content."

      };

    }


    /* ========================================================
       PARSE MODEL JSON
       ======================================================== */

    const parsed =
      extractJsonFromModelContent(
        content
      );


    if (
      !parsed ||
      !Array.isArray(
        parsed.fields
      )
    ) {

      console.error(
        "INVALID SARVAM CONTENT:",
        content
      );


      return {

        success:
          false,

        error:
          "Sarvam response did not contain a valid fields array."

      };

    }


    return {

      success:
        true,

      fields:
        parsed.fields

    };


  } catch (error) {


    console.error(
      "SARVAM REQUEST ERROR:",
      error
    );


    return {

      success:
        false,

      error:
        error?.message ||
        String(error)

    };

  }

}


/* ============================================================
   EXTRACT JSON FROM MODEL RESPONSE
   ============================================================ */

function extractJsonFromModelContent(
  content
) {


  /* ==========================================================
     ALREADY AN OBJECT
     ========================================================== */

  if (
    typeof content ===
      "object" &&
    content !== null
  ) {

    return content;

  }


  if (
    typeof content !==
    "string"
  ) {

    return null;

  }


  const cleaned =
    content.trim();


  /* ==========================================================
     DIRECT JSON
     ========================================================== */

  try {

    return JSON.parse(
      cleaned
    );

  } catch {

    // Continue.

  }


  /* ==========================================================
     JSON CODE FENCE
     ========================================================== */

  const fenceMatch =
    cleaned.match(
      /```(?:json)?\s*([\s\S]*?)```/i
    );


  if (
    fenceMatch
  ) {

    try {

      return JSON.parse(
        fenceMatch[1].trim()
      );

    } catch {

      // Continue.

    }

  }


  /* ==========================================================
     FIND FIRST JSON OBJECT
     ========================================================== */

  const start =
    cleaned.indexOf(
      "{"
    );


  const end =
    cleaned.lastIndexOf(
      "}"
    );


  if (
    start !== -1 &&
    end !== -1 &&
    end > start
  ) {

    try {

      return JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );

    } catch {

      return null;

    }

  }


  return null;

}


/* ============================================================
   SAVE BUSINESS DATA
   ============================================================ */

async function saveBusinessData(
  env,
  data
) {

  try {


    /* ========================================================
       CHECK SUBREQUEST LIMIT
       ======================================================== */

    if (
      nearSubrequestLimit()
    ) {

      return {

        success:
          false,

        error:
          "Cloudflare subrequest safety limit reached before Supabase save."

      };

    }


    /* ========================================================
       SUPABASE REST URL
       ======================================================== */

    const url =
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      `?on_conflict=application_id,field`;


    trackSubrequest();


    /* ========================================================
       UPSERT
       ======================================================== */

    const response =
      await fetch(
        url,
        {

          method:
            "POST",

          headers: {

            "apikey":
              env.SUPABASE_SECRET_KEY,

            "Authorization":
              `Bearer ${env.SUPABASE_SECRET_KEY}`,

            "Content-Type":
              "application/json",

            "Prefer":
              "resolution=merge-duplicates,return=minimal"

          },

          body:
            JSON.stringify(
              data
            )

        }
      );


    const responseText =
      await response.text();


    /* ========================================================
       ERROR
       ======================================================== */

    if (
      !response.ok
    ) {

      console.error(
        "SUPABASE BUSINESS_DATA ERROR:",
        response.status,
        responseText
      );


      let hint =
        "";


      if (
        responseText.includes(
          "42P10"
        ) ||
        responseText
          .toLowerCase()
          .includes(
            "no unique or exclusion constraint"
          )
      ) {

        hint =
          " You need a UNIQUE constraint on " +
          "(application_id, field) in business_data.";

      }


      return {

        success:
          false,

        error:
          `Supabase returned ${response.status}: ${responseText}${hint}`

      };

    }


    console.log(
      "SAVED:",
      data.field
    );


    return {

      success:
        true

    };


  } catch (error) {


    console.error(
      "SUPABASE SAVE ERROR:",
      error
    );


    return {

      success:
        false,

      error:
        error?.message ||
        String(error)

    };

  }

}


/* ============================================================
   NORMALIZE FIELD NAME
   ============================================================ */

function normalizeFieldName(
  field
) {

  if (
    typeof field !==
    "string"
  ) {

    return null;

  }


  let value =
    field
      .trim()
      .toLowerCase();


  value =
    value.replace(
      /[\s-]+/g,
      "_"
    );


  value =
    value.replace(
      /[^a-z0-9_]/g,
      ""
    );


  value =
    value.slice(
      0,
      100
    );


  return (
    value ||
    null
  );

}


/* ============================================================
   NORMALIZE URL
   ============================================================ */

function normalizeUrl(
  url
) {

  const parsed =
    new URL(
      url
    );


  /* ==========================================================
     REMOVE HASH
     ========================================================== */

  parsed.hash =
    "";


  /* ==========================================================
     REMOVE TRACKING PARAMETERS
     ========================================================== */

  const trackingParameters = [

    "utm_source",

    "utm_medium",

    "utm_campaign",

    "utm_term",

    "utm_content",

    "fbclid",

    "gclid"

  ];


  for (
    const parameter
    of trackingParameters
  ) {

    parsed.searchParams.delete(
      parameter
    );

  }


  /* ==========================================================
     REMOVE TRAILING SLASH
     ========================================================== */

  if (
    parsed.pathname !==
    "/"
  ) {

    parsed.pathname =
      parsed.pathname.replace(
        /\/$/,
        ""
      );

  }


  return parsed.href;

}


/* ============================================================
   SAME HOSTNAME
   ============================================================ */

function sameHostname(
  first,
  second
) {

  return (
    first.hostname.toLowerCase() ===
    second.hostname.toLowerCase()
  );

}


/* ============================================================
   IGNORE FILE TYPES
   ============================================================ */

function isLikelyFile(
  pathname
) {

  return /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|zip|rar|mp4|mp3|wav|avi|mov|doc|docx|xls|xlsx|ppt|pptx)$/i
    .test(
      pathname
    );

}


/* ============================================================
   SSRF PROTECTION
   ============================================================ */

function isBlockedHostname(
  hostname
) {

  const host =
    hostname
      .toLowerCase()
      .trim();


  const blocked = [

    "localhost",

    "127.0.0.1",

    "0.0.0.0",

    "::1",

    "metadata.google.internal",

    "metadata.google",

    "169.254.169.254"

  ];


  if (
    blocked.includes(
      host
    )
  ) {

    return true;

  }


  /* ==========================================================
     PRIVATE IPV4
     ========================================================== */

  if (

    /^10\./.test(
      host
    ) ||

    /^192\.168\./.test(
      host
    ) ||

    /^172\.(1[6-9]|2\d|3[0-1])\./.test(
      host
    ) ||

    /^169\.254\./.test(
      host
    )

  ) {

    return true;

  }


  /* ==========================================================
     PRIVATE IPV6
     ========================================================== */

  if (

    host ===
      "::1" ||

    host.startsWith(
      "fc"
    ) ||

    host.startsWith(
      "fd"
    ) ||

    host.startsWith(
      "fe80"
    )

  ) {

    return true;

  }


  return false;

}


/* ============================================================
   FETCH WITH TIMEOUT
   ============================================================ */

async function fetchWithTimeout(
  url,
  options,
  timeout
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () => {
        controller.abort();
      },
      timeout
    );


  try {

    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );

  } finally {

    clearTimeout(
      timer
    );

  }

}


/* ============================================================
   DECODE HTML ENTITIES
   ============================================================ */

function decodeHtmlEntities(
  text
) {

  return text

    .replace(
      /&nbsp;/gi,
      " "
    )

    .replace(
      /&amp;/gi,
      "&"
    )

    .replace(
      /&quot;/gi,
      '"'
    )

    .replace(
      /&#39;/gi,
      "'"
    )

    .replace(
      /&lt;/gi,
      "<"
    )

    .replace(
      /&gt;/gi,
      ">"
    );

}


/* ============================================================
   SUBREQUEST TRACKING
   ============================================================ */

function trackSubrequest() {

  subrequestCount++;

}


function nearSubrequestLimit() {

  return (
    subrequestCount >=
    SUBREQUEST_SAFETY_LIMIT
  );

}


/* ============================================================
   JSON RESPONSE
   ============================================================ */

function jsonResponse(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data,
      null,
      2
    ),

    {

      status:

        status,

      headers: {

        "Content-Type":
          "application/json",

        ...corsHeaders()

      }

    }

  );

}


/* ============================================================
   CORS HEADERS
   ============================================================ */

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"

  };

             }
