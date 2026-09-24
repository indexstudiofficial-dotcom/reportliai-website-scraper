/**
 * ============================================================
 * REPORTLI AI - WEBSITE SCRAPER WORKER
 * ============================================================
 *
 * FLOW:
 *
 * SaaS
 *   ↓
 * Cloudflare Worker
 *   ↓
 * Validate application
 *   ↓
 * Discover internal pages
 *   ↓
 * Fetch ONE page
 *   ↓
 * Extract readable text
 *   ↓
 * Send ONE page to Sarvam AI
 *   ↓
 * Receive structured fields
 *   ↓
 * Save fields to Supabase business_data
 *   ↓
 * Next page
 *
 * ============================================================
 */


/* ============================================================
   CONFIGURATION
   ============================================================ */

// Maximum number of pages to crawl in one request.
//
// IMPORTANT:
// Cloudflare Workers HTTP requests have execution limits.
// For very large websites, we should later move this to
// Cloudflare Queues / Jobs.
//
// Start with 30-50 for testing.
const MAX_PAGES = 50;

// Maximum HTML size we will process per page.
// 2 MB is enough for normal business websites.
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// Maximum text characters sent to Sarvam per page.
//
// This prevents a giant page from creating an unnecessarily
// large AI request.
const MAX_TEXT_CHARS = 30000;

// Timeout for fetching websites.
const FETCH_TIMEOUT_MS = 15000;

// Sarvam endpoint.
//
// We use V1 because sarvam-105b is available on V1.
// V2 is currently beta and requires access per API key.
const SARVAM_API_URL =
  "https://api.sarvam.ai/v1/chat/completions";

// Current Sarvam model.
const SARVAM_MODEL = "sarvam-105b";


/* ============================================================
   MAIN WORKER
   ============================================================ */

export default {

  async fetch(request, env) {

    console.log("==========================================");
    console.log("REPORTLI WEBSITE SCRAPER STARTED");
    console.log("==========================================");

    try {

      /* ======================================================
         1. CORS / OPTIONS
         ====================================================== */

      if (request.method === "OPTIONS") {

        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });

      }


      /* ======================================================
         2. ONLY POST
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
         3. READ JSON BODY
         ====================================================== */

      let body;

      try {

        body = await request.json();

      } catch (error) {

        console.error(
          "STEP 2 FAILED: Invalid JSON",
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

      console.log("STEP 2: Request body received");


      /* ======================================================
         4. SUPPORT BOTH NAMING STYLES
         ====================================================== */

      // Preferred:
      //
      // {
      //   "application_id": "...",
      //   "website_url": "..."
      // }
      //
      // Also accept:
      //
      // {
      //   "applicationId": "...",
      //   "websiteUrl": "..."
      // }

      const applicationId =
        body.application_id ||
        body.applicationId;

      const websiteUrl =
        body.website_url ||
        body.websiteUrl;


      console.log(
        "STEP 3: application_id =",
        applicationId
      );

      console.log(
        "STEP 3: website_url =",
        websiteUrl
      );


      /* ======================================================
         5. VALIDATE APPLICATION ID
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
         6. VALIDATE WEBSITE URL
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
            error: "website_url is missing.",
            received_body: body
          },
          400
        );

      }


      /* ======================================================
         7. NORMALIZE URL
         ====================================================== */

      let startUrl;

      try {

        startUrl = new URL(
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
         8. ONLY HTTP / HTTPS
         ====================================================== */

      if (
        startUrl.protocol !== "https:" &&
        startUrl.protocol !== "http:"
      ) {

        return jsonResponse(
          {
            success: false,
            step: "validate_url",
            error: "Only HTTP and HTTPS websites are supported."
          },
          400
        );

      }


      /* ======================================================
         9. BASIC SSRF PROTECTION
         ====================================================== */

      if (isBlockedHostname(startUrl.hostname)) {

        return jsonResponse(
          {
            success: false,
            step: "validate_url",
            error: "This hostname is not allowed."
          },
          400
        );

      }


      console.log(
        "STEP 4: URL validated:",
        startUrl.href
      );


      /* ======================================================
         10. CHECK REQUIRED ENVIRONMENT VARIABLES
         ====================================================== */

      console.log(
        "STEP 5: Checking Worker secrets..."
      );


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


      console.log(
        "STEP 5: All required secrets exist"
      );


      /* ======================================================
         11. VERIFY APPLICATION EXISTS
         ====================================================== */

      console.log(
        "STEP 6: Checking application in Supabase..."
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
        "STEP 6: Application exists"
      );


      /* ======================================================
         12. DISCOVER WEBSITE PAGES
         ====================================================== */

      console.log(
        "STEP 7: Discovering internal pages..."
      );


      const pages =
        await discoverPages(
          startUrl
        );


      console.log(
        "STEP 7: Pages discovered:",
        pages.length
      );


      if (!pages.length) {

        return jsonResponse(
          {
            success: false,
            step: "discover_pages",
            error: "Could not find any crawlable pages."
          },
          422
        );

      }


      /* ======================================================
         13. PROCESS EACH PAGE
         ====================================================== */

      const results = [];

      let totalFieldsSaved = 0;

      let successfulPages = 0;

      let failedPages = 0;


      for (
        let index = 0;
        index < pages.length;
        index++
      ) {

        const pageUrl = pages[index];

        console.log(
          "------------------------------------------"
        );

        console.log(
          `PAGE ${index + 1}/${pages.length}`
        );

        console.log(
          "URL:",
          pageUrl
        );


        try {

          /* ==================================================
             FETCH PAGE
             ================================================== */

          const pageResult =
            await fetchPage(
              pageUrl
            );


          if (!pageResult.success) {

            failedPages++;

            results.push({
              url: pageUrl,
              success: false,
              step: "fetch_page",
              error: pageResult.error
            });

            continue;

          }


          console.log(
            "HTML length:",
            pageResult.html.length
          );


          /* ==================================================
             EXTRACT TEXT
             ================================================== */

          const pageText =
            extractText(
              pageResult.html
            );


          console.log(
            "Extracted text:",
            pageText.length,
            "characters"
          );


          if (!pageText) {

            failedPages++;

            results.push({
              url: pageUrl,
              success: false,
              step: "extract_text",
              error: "No readable text found."
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
              error: aiResult.error
            });

            continue;

          }


          console.log(
            "Sarvam fields received:",
            aiResult.fields.length
          );


          /* ==================================================
             SAVE SARVAM FIELDS TO SUPABASE
             ================================================== */

          let pageFieldsSaved = 0;


          for (
            const extractedField of aiResult.fields
          ) {

            const fieldName =
              normalizeFieldName(
                extractedField.field
              );


            if (!fieldName) {

              console.log(
                "Skipping empty field"
              );

              continue;

            }


            const data =
              extractedField.data;


            if (
              data === undefined ||
              data === null
            ) {

              console.log(
                "Skipping empty data for:",
                fieldName
              );

              continue;

            }


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


            if (!saveResult.success) {

              console.error(
                "Supabase save failed:",
                fieldName,
                saveResult.error
              );

              continue;

            }


            pageFieldsSaved++;

            totalFieldsSaved++;

          }


          /* ==================================================
             PAGE SUCCESS
             ================================================== */

          successfulPages++;


          results.push({
            url: pageUrl,
            success: true,
            fields_found: aiResult.fields.length,
            fields_saved: pageFieldsSaved
          });


          console.log(
            `PAGE ${index + 1} COMPLETE`
          );


        } catch (pageError) {

          failedPages++;


          console.error(
            "PAGE ERROR:",
            pageError
          );


          results.push({
            url: pageUrl,
            success: false,
            step: "page_processing",
            error:
              pageError?.message ||
              String(pageError)
          });

        }

      }


      /* ======================================================
         14. FINAL RESPONSE
         ====================================================== */

      console.log(
        "=========================================="
      );

      console.log(
        "SCRAPER FINISHED"
      );

      console.log(
        "Successful pages:",
        successfulPages
      );

      console.log(
        "Failed pages:",
        failedPages
      );

      console.log(
        "Total fields saved:",
        totalFieldsSaved
      );

      console.log(
        "=========================================="
      );


      return jsonResponse(
        {
          success: true,

          message:
            "Website scraping completed.",

          application_id:
            applicationId,

          website_url:
            startUrl.href,

          pages_discovered:
            pages.length,

          pages_successful:
            successfulPages,

          pages_failed:
            failedPages,

          fields_saved:
            totalFieldsSaved,

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
          success: false,

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
   GET APPLICATION FROM SUPABASE
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


    const response =
      await fetch(
        url.toString(),
        {
          method: "GET",

          headers: {
            "apikey":
              env.SUPABASE_SECRET_KEY,

            "Authorization":
              `Bearer ${env.SUPABASE_SECRET_KEY}`
          }
        }
      );


    const text =
      await response.text();


    console.log(
      "Supabase application check:",
      response.status
    );


    if (!response.ok) {

      return {
        success: false,
        status: 500,
        error:
          `Supabase application check failed: ${text}`
      };

    }


    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

      return {
        success: false,
        status: 500,
        error:
          "Supabase returned invalid JSON."
      };

    }


    if (
      !Array.isArray(data) ||
      data.length === 0
    ) {

      return {
        success: false,
        status: 404,
        error:
          "The application_id does not exist in the applications table.",
        application_id:
          applicationId
      };

    }


    return {
      success: true
    };


  } catch (error) {

    return {
      success: false,
      status: 500,
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

  const discovered =
    new Set();

  const queue = [];


  const normalizedStart =
    normalizeUrl(
      startUrl.href
    );


  discovered.add(
    normalizedStart
  );


  queue.push(
    normalizedStart
  );


  while (
    queue.length > 0 &&
    discovered.size < MAX_PAGES
  ) {

    const currentUrl =
      queue.shift();


    try {

      console.log(
        "Discovering:",
        currentUrl
      );


      const response =
        await fetchWithTimeout(
          currentUrl,
          {
            method: "GET",

            headers: {
              "User-Agent":
                "ReportliAI-WebsiteCrawler/1.0",
              "Accept":
                "text/html,application/xhtml+xml"
            }
          },
          FETCH_TIMEOUT_MS
        );


      if (!response.ok) {

        console.log(
          "Skipping page:",
          currentUrl,
          "HTTP",
          response.status
        );

        continue;

      }


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


      const html =
        await response.text();


      const links =
        extractLinks(
          html,
          new URL(currentUrl)
        );


      for (
        const link of links
      ) {

        if (
          discovered.size >= MAX_PAGES
        ) {

          break;

        }


        if (
          !sameHostname(
            new URL(currentUrl),
            new URL(link)
          )
        ) {

          continue;

        }


        if (
          discovered.has(link)
        ) {

          continue;

        }


        discovered.add(link);

        queue.push(link);

      }


    } catch (error) {

      console.log(
        "Discovery error:",
        currentUrl,
        error?.message ||
          String(error)
      );

    }

  }


  return Array.from(
    discovered
  );

}


/* ============================================================
   EXTRACT LINKS FROM HTML
   ============================================================ */

function extractLinks(
  html,
  currentUrl
) {

  const links =
    new Set();


  /*
   * Basic href extraction.
   *
   * This works well for normal server-rendered HTML.
   */

  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;


  let match;


  while (
    (match = regex.exec(html)) !== null
  ) {

    const href =
      match[1];


    if (!href) {
      continue;
    }


    /*
     * Ignore:
     * - javascript:
     * - mailto:
     * - tel:
     * - fragments
     * - files
     */

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


      if (
        absoluteUrl.protocol !== "http:" &&
        absoluteUrl.protocol !== "https:"
      ) {

        continue;

      }


      if (
        !sameHostname(
          currentUrl,
          absoluteUrl
        )
      ) {

        continue;

      }


      if (
        isLikelyFile(
          absoluteUrl.pathname
        )
      ) {

        continue;

      }


      const normalized =
        normalizeUrl(
          absoluteUrl.href
        );


      links.add(
        normalized
      );


    } catch {

      // Ignore malformed links.

    }

  }


  return Array.from(
    links
  );

}


/* ============================================================
   FETCH ONE PAGE
   ============================================================ */

async function fetchPage(
  pageUrl
) {

  try {

    const response =
      await fetchWithTimeout(
        pageUrl,
        {
          method: "GET",

          headers: {
            "User-Agent":
              "ReportliAI-WebsiteCrawler/1.0",

            "Accept":
              "text/html,application/xhtml+xml"
          }
        },
        FETCH_TIMEOUT_MS
      );


    if (!response.ok) {

      return {
        success: false,

        error:
          `Website returned HTTP ${response.status}`
      };

    }


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

      return {
        success: false,

        error:
          `Not an HTML page. Content-Type: ${contentType}`
      };

    }


    const html =
      await response.text();


    if (!html) {

      return {
        success: false,

        error:
          "Empty HTML response."
      };

    }


    if (
      new TextEncoder().encode(html).length >
      MAX_HTML_BYTES
    ) {

      return {
        success: false,

        error:
          "HTML page is too large."
      };

    }


    return {
      success: true,
      html: html
    };


  } catch (error) {

    return {
      success: false,

      error:
        error?.message ||
        String(error)
    };

  }

}


/* ============================================================
   EXTRACT READABLE TEXT
   ============================================================ */

function extractText(
  html
) {

  let text =
    html;


  /*
   * Remove scripts.
   */

  text =
    text.replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    );


  /*
   * Remove styles.
   */

  text =
    text.replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    );


  /*
   * Remove noscript.
   */

  text =
    text.replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      " "
    );


  /*
   * Remove SVG.
   */

  text =
    text.replace(
      /<svg[\s\S]*?<\/svg>/gi,
      " "
    );


  /*
   * Remove HTML tags.
   */

  text =
    text.replace(
      /<[^>]+>/g,
      " "
    );


  /*
   * Decode common HTML entities.
   */

  text =
    decodeHtmlEntities(
      text
    );


  /*
   * Normalize whitespace.
   */

  text =
    text.replace(
      /\s+/g,
      " "
    );


  return text.trim();

}


/* ============================================================
   SARVAM AI
   ============================================================ */

async function extractBusinessDataWithSarvam(
  env,
  pageUrl,
  pageText
) {

  try {

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
9. Do not create fields for navigation menus, cookie banners, tracking text,
   footer copyright text, or unrelated technical content.
10. If a value contains multiple items, return an array when appropriate.
11. Preserve important factual wording.
12. Never return markdown.
13. Return JSON only.
`;


    const userPrompt = `
SOURCE URL:
${pageUrl}

WEBPAGE TEXT:
${pageText}
`;


    const requestBody = {

      model:
        SARVAM_MODEL,

      messages: [

        {
          role: "system",

          content:
            systemPrompt
        },

        {
          role: "user",

          content:
            userPrompt
        }

      ],

      temperature: 0,

      max_tokens: 3000,

      response_format: {

        type: "json_schema",

        json_schema: {

          name:
            "business_information",

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

                    field: {
                      type: "string"
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


    console.log(
      "Calling Sarvam:",
      SARVAM_MODEL
    );


    const response =
      await fetch(
        SARVAM_API_URL,
        {
          method: "POST",

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
      "Sarvam status:",
      response.status
    );


    if (!response.ok) {

      console.error(
        "Sarvam error:",
        responseText
      );


      return {

        success: false,

        error:
          `Sarvam API returned ${response.status}: ${responseText}`

      };

    }


    let result;


    try {

      result =
        JSON.parse(
          responseText
        );

    } catch {

      return {

        success: false,

        error:
          "Sarvam returned invalid JSON."

      };

    }


    /*
     * Current Sarvam Chat Completions response:
     *
     * choices[0].message.content
     */

    const content =
      result
        ?.choices?.[0]
        ?.message
        ?.content;


    if (!content) {

      return {

        success: false,

        error:
          "Sarvam response did not contain message.content."

      };

    }


    let parsed;


    try {

      parsed =
        typeof content === "string"
          ? JSON.parse(content)
          : content;

    } catch {

      console.error(
        "Could not parse Sarvam content:",
        content
      );


      return {

        success: false,

        error:
          "Sarvam returned content that was not valid JSON."

      };

    }


    if (
      !parsed ||
      !Array.isArray(
        parsed.fields
      )
    ) {

      return {

        success: false,

        error:
          "Sarvam JSON did not contain a fields array."

      };

    }


    return {

      success: true,

      fields:
        parsed.fields

    };


  } catch (error) {

    console.error(
      "Sarvam request error:",
      error
    );


    return {

      success: false,

      error:
        error?.message ||
        String(error)

    };

  }

}


/* ============================================================
   SAVE BUSINESS DATA
   ============================================================ */

async function saveBusinessData(
  env,
  data
) {

  try {

    const url =
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      `?on_conflict=application_id,field`;


    const response =
      await fetch(
        url,
        {
          method: "POST",

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


    if (!response.ok) {

      console.error(
        "SUPABASE BUSINESS_DATA ERROR:",
        response.status,
        responseText
      );


      return {

        success: false,

        error:
          `Supabase returned ${response.status}: ${responseText}`

      };

    }


    console.log(
      "Saved field:",
      data.field
    );


    return {

      success: true

    };


  } catch (error) {

    console.error(
      "Supabase save exception:",
      error
    );


    return {

      success: false,

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
    typeof field !== "string"
  ) {

    return null;

  }


  let value =
    field
      .trim()
      .toLowerCase();


  /*
   * Convert spaces and hyphens to underscores.
   */

  value =
    value.replace(
      /[\s-]+/g,
      "_"
    );


  /*
   * Remove unusual characters.
   */

  value =
    value.replace(
      /[^a-z0-9_]/g,
      ""
    );


  /*
   * Prevent enormous field names.
   */

  value =
    value.slice(
      0,
      100
    );


  return value || null;

}


/* ============================================================
   URL NORMALIZATION
   ============================================================ */

function normalizeUrl(
  url
) {

  const parsed =
    new URL(url);


  /*
   * Remove hash.
   */

  parsed.hash = "";


  /*
   * Remove common tracking parameters.
   */

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


  /*
   * Remove trailing slash except
   * for root domain.
   */

  if (
    parsed.pathname !== "/"
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
   IGNORE FILES
   ============================================================ */

function isLikelyFile(
  pathname
) {

  return /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|zip|rar|mp4|mp3|wav|avi|mov|doc|docx|xls|xlsx|ppt|pptx)$/i
    .test(pathname);

}


/* ============================================================
   BASIC BLOCKED HOSTNAME CHECK
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
    "metadata.google"

  ];


  if (
    blocked.includes(host)
  ) {

    return true;

  }


  /*
   * IPv4 private ranges.
   */

  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
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
      () => controller.abort(),
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
   DECODE BASIC HTML ENTITIES
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
   CORS
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
