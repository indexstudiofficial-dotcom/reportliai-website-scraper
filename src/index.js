// ============================================================
// AI BUSINESS WEBSITE KNOWLEDGE SCRAPER
// Cloudflare Worker + Sarvam 105B + Supabase
//
// VERSION: 2
//
// FIXES:
// 1. Adds missing cleanText() helper.
// 2. Never processes sitemap XML as a webpage.
// 3. Filters XML/PDF/image/file URLs from page queue.
// 4. Bulk-saves all fields from one page in ONE Supabase call.
// 5. Merges fields from multiple AI chunks.
// 6. Uses small batches suitable for Cloudflare Free.
// 7. Keeps pagination with page_offset.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {

  // Maximum normal webpages processed per invocation.
  MAX_PAGES_PER_INVOCATION: 5,

  // Maximum Sarvam calls in one invocation.
  MAX_AI_CALLS_PER_INVOCATION: 20,

  // Maximum chunks from one webpage.
  MAX_CHUNKS_PER_PAGE: 4,

  // Characters per AI chunk.
  CHUNK_SIZE: 12000,

  // Overlap between chunks.
  CHUNK_OVERLAP: 800,

  // Maximum HTML size.
  MAX_HTML_BYTES: 2 * 1024 * 1024,

  // Website request timeout.
  FETCH_TIMEOUT_MS: 12000,

  // Maximum discovered URLs.
  MAX_DISCOVERED_URLS: 500,

  // Maximum sitemap files inspected.
  MAX_SITEMAPS: 10,

  // Sarvam model.
  SARVAM_MODEL: "sarvam-105b",

  // Disable reasoning for extraction.
  REASONING_EFFORT: null,

  // Supabase table.
  SUPABASE_TABLE: "business_data",

  // User agent.
  USER_AGENT:
    "Mozilla/5.0 (compatible; AI-Business-Knowledge-Bot/2.0)"
};


// ============================================================
// FILE EXTENSIONS THAT ARE NOT WEB PAGES
// ============================================================

const NON_HTML_EXTENSIONS = [

  ".xml",
  ".xml.gz",

  ".pdf",

  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",

  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",

  ".mp4",
  ".webm",
  ".mov",

  ".zip",
  ".rar",
  ".7z",

  ".doc",
  ".docx",

  ".xls",
  ".xlsx",

  ".ppt",
  ".pptx",

  ".csv",

  ".json",

  ".txt"
];


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env, ctx) {

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }


    // --------------------------------------------------------
    // POST ONLY
    // --------------------------------------------------------

    if (request.method !== "POST") {

      return jsonResponse(
        {
          success: false,
          error: "Only POST requests are supported."
        },
        405
      );
    }


    // --------------------------------------------------------
    // CHECK ENVIRONMENT
    // --------------------------------------------------------

    const requiredEnv = [

      "SUPABASE_URL",

      "SUPABASE_SECRET_KEY",

      "SARVAM_API_KEY"
    ];


    const missingEnv =
      requiredEnv.filter(
        key => !env[key]
      );


    if (missingEnv.length > 0) {

      return jsonResponse(
        {
          success: false,

          error:
            "Missing environment variables.",

          missing:
            missingEnv
        },
        500
      );
    }


    // --------------------------------------------------------
    // READ JSON
    // --------------------------------------------------------

    let body;


    try {

      body =
        await request.json();

    } catch {

      return jsonResponse(
        {
          success: false,

          error:
            "Request body must be valid JSON."
        },
        400
      );
    }


    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    const applicationId =
      String(
        body.application_id || ""
      ).trim();


    const websiteInput =
      String(
        body.domain ||
        body.website ||
        body.website_url ||
        ""
      ).trim();


    const requestedMaxPages =
      Number(
        body.max_pages
      );


    const pageOffset =
      Math.max(
        0,
        Number.isFinite(
          Number(body.page_offset)
        )
          ? Number(body.page_offset)
          : 0
      );


    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (!applicationId) {

      return jsonResponse(
        {
          success: false,

          error:
            "application_id is required."
        },
        400
      );
    }


    if (!websiteInput) {

      return jsonResponse(
        {
          success: false,

          error:
            "domain or website_url is required."
        },
        400
      );
    }


    // --------------------------------------------------------
    // NORMALIZE WEBSITE
    // --------------------------------------------------------

    let website;


    try {

      website =
        normalizeWebsite(
          websiteInput
        );

    } catch {

      return jsonResponse(
        {
          success: false,

          error:
            "Invalid website URL."
        },
        400
      );
    }


    // --------------------------------------------------------
    // PAGE LIMIT
    // --------------------------------------------------------

    let pagesPerInvocation =
      CONFIG.MAX_PAGES_PER_INVOCATION;


    if (
      Number.isFinite(
        requestedMaxPages
      ) &&
      requestedMaxPages > 0
    ) {

      pagesPerInvocation =
        Math.min(
          Math.floor(
            requestedMaxPages
          ),
          CONFIG.MAX_PAGES_PER_INVOCATION
        );
    }


    // ========================================================
    // REQUEST BUDGET
    // ========================================================

    const budget = {

      websiteFetches: 0,

      aiCalls: 0,

      supabaseWrites: 0,

      discoveryRequests: 0
    };


    // ========================================================
    // DISCOVER URLS
    // ========================================================

    let discoveredUrls;


    try {

      discoveredUrls =
        await discoverWebsiteUrls(
          website,
          budget
        );

    } catch (error) {

      return jsonResponse(
        {
          success: false,

          application_id:
            applicationId,

          website,

          error:
            "Website discovery failed.",

          details:
            safeError(error)
        },
        500
      );
    }


    // --------------------------------------------------------
    // FILTER ONLY REAL WEB PAGES
    // --------------------------------------------------------

    discoveredUrls =
      discoveredUrls
        .filter(
          url =>
            isProcessablePageUrl(
              url
            )
        );


    // --------------------------------------------------------
    // DEDUPLICATE
    // --------------------------------------------------------

    discoveredUrls =
      uniqueUrls(
        discoveredUrls
      )
      .slice(
        0,
        CONFIG.MAX_DISCOVERED_URLS
      );


    // --------------------------------------------------------
    // ALWAYS KEEP HOMEPAGE FIRST
    // --------------------------------------------------------

    discoveredUrls =
      prioritizeHomepage(
        discoveredUrls,
        website
      );


    // ========================================================
    // SELECT CURRENT BATCH
    // ========================================================

    const selectedUrls =
      discoveredUrls.slice(
        pageOffset,
        pageOffset +
          pagesPerInvocation
      );


    // ========================================================
    // STATS
    // ========================================================

    const stats = {

      pages_discovered:
        discoveredUrls.length,

      pages_selected:
        selectedUrls.length,

      pages_processed:
        0,

      pages_failed:
        0,

      chunks_sent_to_ai:
        0,

      fields_extracted:
        0,

      fields_saved:
        0,

      fields_failed:
        0,

      sarvam_errors:
        0
    };


    const pageResults = [];


    // ========================================================
    // PROCESS SELECTED PAGES
    // ========================================================

    for (
      const pageUrl of selectedUrls
    ) {

      try {

        const result =
          await processPage(
            pageUrl,
            applicationId,
            env,
            budget
          );


        // ----------------------------------------------------
        // UPDATE STATS
        // ----------------------------------------------------

        stats.chunks_sent_to_ai +=
          result.chunks_sent_to_ai;


        stats.fields_extracted +=
          result.fields_extracted;


        stats.fields_saved +=
          result.fields_saved;


        stats.fields_failed +=
          result.fields_failed;


        stats.sarvam_errors +=
          result.sarvam_errors;


        if (
          result.success
        ) {

          stats.pages_processed++;

        } else {

          stats.pages_failed++;
        }


        pageResults.push(
          result
        );

      } catch (error) {

        stats.pages_failed++;


        pageResults.push(
          {
            url:
              pageUrl,

            success:
              false,

            error:
              safeError(error)
          }
        );
      }
    }


    // ========================================================
    // PAGINATION
    // ========================================================

    const nextOffset =
      pageOffset +
      selectedUrls.length;


    const hasMorePages =
      nextOffset <
      discoveredUrls.length;


    // ========================================================
    // RESPONSE
    // ========================================================

    return jsonResponse(
      {

        success:
          true,

        application_id:
          applicationId,

        website,

        stats,

        pagination: {

          page_offset:
            pageOffset,

          next_offset:
            hasMorePages
              ? nextOffset
              : null,

          has_more_pages:
            hasMorePages,

          total_pages:
            discoveredUrls.length
        },

        budget: {

          website_fetches:
            budget.websiteFetches,

          ai_calls:
            budget.aiCalls,

          supabase_writes:
            budget.supabaseWrites,

          discovery_requests:
            budget.discoveryRequests
        },

        page_results:
          pageResults,

        message:
          hasMorePages
            ? `Batch completed. Continue with page_offset=${nextOffset}.`
            : "All discovered pages have been processed."
      },

      200
    );
  }
};


// ============================================================
// PROCESS ONE PAGE
// ============================================================

async function processPage(
  pageUrl,
  applicationId,
  env,
  budget
) {

  const result = {

    url:
      pageUrl,

    success:
      false,

    chunks_sent_to_ai:
      0,

    fields_extracted:
      0,

    fields_saved:
      0,

    fields_failed:
      0,

    sarvam_errors:
      0
  };


  // ----------------------------------------------------------
  // FETCH HTML
  // ----------------------------------------------------------

  const html =
    await fetchHtml(
      pageUrl,
      budget
    );


  // ----------------------------------------------------------
  // EXTRACT TEXT
  // ----------------------------------------------------------

  const pageData =
    extractReadableContent(
      html,
      pageUrl
    );


  // ----------------------------------------------------------
  // EMPTY PAGE
  // ----------------------------------------------------------

  if (
    !pageData.text ||
    pageData.text.length < 50
  ) {

    result.success =
      true;

    return result;
  }


  // ----------------------------------------------------------
  // CHUNK PAGE
  // ----------------------------------------------------------

  let chunks =
    splitTextIntoChunks(
      pageData.text,
      CONFIG.CHUNK_SIZE,
      CONFIG.CHUNK_OVERLAP
    );


  // ----------------------------------------------------------
  // LIMIT CHUNKS
  // ----------------------------------------------------------

  if (
    chunks.length >
    CONFIG.MAX_CHUNKS_PER_PAGE
  ) {

    chunks =
      chunks.slice(
        0,
        CONFIG.MAX_CHUNKS_PER_PAGE
      );
  }


  // ----------------------------------------------------------
  // MERGED FIELDS
  // ----------------------------------------------------------

  const mergedFields =
    new Map();


  // ==========================================================
  // AI CHUNKS
  // ==========================================================

  for (
    let chunkIndex = 0;
    chunkIndex < chunks.length;
    chunkIndex++
  ) {

    // --------------------------------------------------------
    // AI BUDGET
    // --------------------------------------------------------

    if (
      budget.aiCalls >=
      CONFIG.MAX_AI_CALLS_PER_INVOCATION
    ) {

      break;
    }


    const chunk =
      chunks[
        chunkIndex
      ];


    try {

      const extracted =
        await extractWithSarvam(
          {
            url:
              pageUrl,

            title:
              pageData.title,

            chunk,

            chunkIndex,

            totalChunks:
              chunks.length
          },

          env,

          budget
        );


      result.chunks_sent_to_ai++;


      // ------------------------------------------------------
      // NORMALIZE + MERGE
      // ------------------------------------------------------

      for (
        const item of extracted
      ) {

        const normalized =
          normalizeField(
            item
          );


        if (!normalized) {
          continue;
        }


        result.fields_extracted++;


        const existing =
          mergedFields.get(
            normalized.field
          );


        if (existing) {

          existing.data =
            mergeValues(
              existing.data,
              normalized.data
            );

        } else {

          mergedFields.set(
            normalized.field,

            {
              field:
                normalized.field,

              data:
                normalized.data
            }
          );
        }
      }

    } catch {

      result.sarvam_errors++;
    }
  }


  // ----------------------------------------------------------
  // NOTHING EXTRACTED
  // ----------------------------------------------------------

  if (
    mergedFields.size === 0
  ) {

    result.success =
      result.sarvam_errors === 0;

    return result;
  }


  // ==========================================================
  // PREPARE BULK ROWS
  // ==========================================================

  const rows =
    Array.from(
      mergedFields.values()
    )
    .map(
      item => ({

        application_id:
          applicationId,

        field:
          item.field,

        data:
          item.data,

        source_url:
          pageUrl,

        updated_at:
          new Date().toISOString()
      })
    );


  // ==========================================================
  // ONE SUPABASE REQUEST
  // ==========================================================

  try {

    const saved =
      await bulkSaveToSupabase(
        rows,
        env,
        budget
      );


    result.fields_saved =
      saved.saved;


    result.fields_failed =
      saved.failed;


    result.success =
      saved.failed === 0;

  } catch (error) {

    result.success =
      false;

    result.fields_failed =
      rows.length;

    result.error =
      safeError(error);
  }


  return result;
}


// ============================================================
// FETCH HTML PAGE
// ============================================================

async function fetchHtml(
  url,
  budget
) {

  // ----------------------------------------------------------
  // SAFETY
  // ----------------------------------------------------------

  if (
    budget.websiteFetches >=
    CONFIG.MAX_PAGES_PER_INVOCATION
  ) {

    throw new Error(
      "Website fetch safety limit reached."
    );
  }


  budget.websiteFetches++;


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () =>
        controller.abort(),

      CONFIG.FETCH_TIMEOUT_MS
    );


  try {

    const response =
      await fetch(
        url,
        {

          method:
            "GET",

          redirect:
            "follow",

          headers: {

            "User-Agent":
              CONFIG.USER_AGENT,

            "Accept":
              "text/html,application/xhtml+xml"
          },

          signal:
            controller.signal
        }
      );


    if (
      !response.ok
    ) {

      throw new Error(
        `Website returned HTTP ${response.status}`
      );
    }


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    // --------------------------------------------------------
    // IMPORTANT:
    // XML IS NOT A PAGE
    // --------------------------------------------------------

    if (
      !contentType.includes(
        "text/html"
      ) &&
      !contentType.includes(
        "application/xhtml+xml"
      )
    ) {

      throw new Error(
        `Not an HTML page: ${contentType}`
      );
    }


    const contentLength =
      Number(
        response.headers.get(
          "content-length"
        ) || 0
      );


    if (
      contentLength >
      CONFIG.MAX_HTML_BYTES
    ) {

      throw new Error(
        "HTML page is too large."
      );
    }


    const text =
      await response.text();


    if (
      text.length >
      CONFIG.MAX_HTML_BYTES
    ) {

      throw new Error(
        "HTML page exceeded maximum size."
      );
    }


    return text;

  } finally {

    clearTimeout(
      timeout
    );
  }
}


// ============================================================
// EXTRACT READABLE WEBSITE CONTENT
// ============================================================

function extractReadableContent(
  html,
  url
) {

  // ----------------------------------------------------------
  // TITLE
  // ----------------------------------------------------------

  const title =
    matchTag(
      html,
      "title"
    );


  // ----------------------------------------------------------
  // REMOVE UNNECESSARY HTML
  // ----------------------------------------------------------

  let cleaned =
    html

      .replace(
        /<!--[\s\S]*?-->/g,
        " "
      )

      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        " "
      )

      .replace(
        /<style\b[^>]*>[\s\S]*?<\/style>/gi,
        " "
      )

      .replace(
        /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
        " "
      )

      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
        " "
      )

      .replace(
        /<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi,
        " "
      )

      .replace(
        /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
        " "
      )

      .replace(
        /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
        " "
      )

      .replace(
        /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
        " "
      )

      .replace(
        /<aside\b[^>]*>[\s\S]*?<\/aside>/gi,
        " "
      )

      .replace(
        /<head\b[^>]*>[\s\S]*?<\/head>/gi,
        " "
      );


  // ----------------------------------------------------------
  // LINE BREAKS
  // ----------------------------------------------------------

  cleaned =
    cleaned

      .replace(
        /<\/(p|div|section|article|main|header|li|h1|h2|h3|h4|h5|h6|tr)>/gi,
        "\n"
      )

      .replace(
        /<(br|hr)\s*\/?>/gi,
        "\n"
      );


  // ----------------------------------------------------------
  // REMOVE HTML TAGS
  // ----------------------------------------------------------

  cleaned =
    cleaned.replace(
      /<[^>]+>/g,
      " "
    );


  // ----------------------------------------------------------
  // DECODE ENTITIES
  // ----------------------------------------------------------

  cleaned =
    decodeHtmlEntities(
      cleaned
    );


  // ----------------------------------------------------------
  // CLEAN WHITESPACE
  // ----------------------------------------------------------

  cleaned =
    cleaned

      .replace(
        /\r/g,
        ""
      )

      .replace(
        /[ \t]+/g,
        " "
      )

      .replace(
        /\n\s*\n\s*\n+/g,
        "\n\n"
      )

      .trim();


  // ----------------------------------------------------------
  // REMOVE REPEATED BOILERPLATE
  // ----------------------------------------------------------

  cleaned =
    removeRepeatedLines(
      cleaned
    );


  return {

    url:

      url,

    title:

      cleanText(
        title
      ),

    text:

      cleaned
  };
}


// ============================================================
// CLEAN TEXT
// ============================================================
//
// THIS FUNCTION WAS MISSING IN THE PREVIOUS VERSION.
// That caused:
//
// "cleanText is not defined"
//
// ============================================================

function cleanText(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";
  }


  return String(
    value
  )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


// ============================================================
// SARVAM EXTRACTION
// ============================================================

async function extractWithSarvam(
  page,
  env,
  budget
) {

  budget.aiCalls++;


  // ----------------------------------------------------------
  // SYSTEM PROMPT
  // ----------------------------------------------------------

  const systemPrompt = `
You are an AI business knowledge extraction engine.

Your job is to extract factual information from website content.

The extracted information will be stored in a database and later
used by AI employees such as:

- AI receptionist
- WhatsApp customer support
- sales agent
- appointment agent
- customer support agent
- Gmail agent

RULES:

1. Extract ONLY facts explicitly present in the content.
2. NEVER invent facts.
3. NEVER guess missing information.
4. Extract as much useful business information as possible.
5. Use meaningful lowercase snake_case field names.
6. Do not use generic field names.
7. Preserve exact names, prices, phone numbers, emails,
   addresses, services, policies and URLs.
8. If multiple values exist, preserve ALL of them.
9. Arrays are preferred for lists.
10. Objects are preferred for structured information.
11. Ignore navigation menus.
12. Ignore cookie notices.
13. Ignore tracking information.
14. Ignore CSS.
15. Ignore JavaScript.
16. Ignore technical website boilerplate.
17. Ignore repeated footer content.
18. Do not summarize away useful details.
19. Do not create fields from meaningless text.
20. Do not create duplicate fields with different names.

GOOD FIELD NAMES:

business_name
business_description
services
service_details
service_prices
opening_hours
appointment_information
phone_numbers
email_addresses
physical_address
locations
doctors
dentists
doctor_qualifications
emergency_services
payment_methods
insurance_information
cancellation_policy
refund_policy
contact_information
whatsapp_number
social_media
faq
service_areas
products
product_prices
facilities
parking_information
about_company
company_history
languages_supported
special_offers

BAD FIELD NAMES:

text
page_text
section
content
data
information
unknown
misc
miscellaneous
other
random

If the page contains useful information that does not fit the
examples, create a specific meaningful field.

Return JSON only.
`;


  // ----------------------------------------------------------
  // USER PROMPT
  // ----------------------------------------------------------

  const userPrompt = `
WEBSITE:
${page.url}

PAGE TITLE:
${page.title || "(no title)"}

CHUNK:
${page.chunkIndex + 1} of ${page.totalChunks}

CONTENT:
${page.chunk}

Extract every useful factual business fact from this content.
`;


  // ----------------------------------------------------------
  // CALL SARVAM
  // ----------------------------------------------------------

  const response =
    await fetch(
      "https://api.sarvam.ai/v1/chat/completions",
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
          JSON.stringify({

            model:
              CONFIG.SARVAM_MODEL,

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
              0.1,

            reasoning_effort:
              CONFIG.REASONING_EFFORT,

            max_tokens:
              4096,

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

                          data: {

                            anyOf: [

                              {
                                type:
                                  "string"
                              },

                              {
                                type:
                                  "number"
                              },

                              {
                                type:
                                  "boolean"
                              },

                              {
                                type:
                                  "array",

                                items: {}
                              },

                              {
                                type:
                                  "object",

                                additionalProperties:
                                  true
                              }
                            ]
                          }
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
          })
      }
    );


  // ----------------------------------------------------------
  // SARVAM ERROR
  // ----------------------------------------------------------

  if (
    !response.ok
  ) {

    const errorText =
      await safeReadText(
        response
      );


    throw new Error(
      `Sarvam HTTP ${response.status}: ${errorText}`
    );
  }


  // ----------------------------------------------------------
  // READ RESPONSE
  // ----------------------------------------------------------

  const json =
    await response.json();


  const content =
    json?.choices?.[0]?.message?.content;


  if (!content) {

    throw new Error(
      "Sarvam returned no message content."
    );
  }


  // ----------------------------------------------------------
  // PARSE JSON
  // ----------------------------------------------------------

  let parsed;


  if (
    typeof content ===
    "string"
  ) {

    parsed =
      parseJsonObject(
        content
      );

  } else {

    parsed =
      content;
  }


  // ----------------------------------------------------------
  // VALIDATE
  // ----------------------------------------------------------

  if (
    !parsed ||
    !Array.isArray(
      parsed.fields
    )
  ) {

    throw new Error(
      "Sarvam returned invalid structured data."
    );
  }


  return parsed.fields;
}


// ============================================================
// NORMALIZE AI FIELD
// ============================================================

function normalizeField(
  item
) {

  if (
    !item ||
    typeof item !== "object"
  ) {

    return null;
  }


  let field =
    String(
      item.field || ""
    )

      .trim()

      .toLowerCase();


  // ----------------------------------------------------------
  // SNAKE CASE
  // ----------------------------------------------------------

  field =
    field

      .replace(
        /[^\p{L}\p{N}]+/gu,
        "_"
      )

      .replace(
        /^_+|_+$/g,
        ""
      )

      .replace(
        /_+/g,
        "_"
      );


  if (
    !field ||
    field.length < 2
  ) {

    return null;
  }


  // ----------------------------------------------------------
  // FORBIDDEN FIELDS
  // ----------------------------------------------------------

  const forbidden =
    new Set([

      "text",

      "page_text",

      "section",

      "content",

      "data",

      "information",

      "unknown",

      "misc",

      "miscellaneous",

      "other",

      "random",

      "details"
    ]);


  if (
    forbidden.has(
      field
    )
  ) {

    return null;
  }


  // ----------------------------------------------------------
  // DATA
  // ----------------------------------------------------------

  let data =
    item.data;


  if (
    data === null ||
    data === undefined
  ) {

    return null;
  }


  if (
    typeof data ===
    "string"
  ) {

    data =
      data.trim();


    if (!data) {

      return null;
    }
  }


  return {

    field,

    data
  };
}


// ============================================================
// MERGE AI VALUES
// ============================================================

function mergeValues(
  oldValue,
  newValue
) {

  // ----------------------------------------------------------
  // BOTH ARRAYS
  // ----------------------------------------------------------

  if (
    Array.isArray(
      oldValue
    ) &&
    Array.isArray(
      newValue
    )
  ) {

    return uniqueArray([

      ...oldValue,

      ...newValue

    ]);
  }


  // ----------------------------------------------------------
  // OLD ARRAY
  // ----------------------------------------------------------

  if (
    Array.isArray(
      oldValue
    )
  ) {

    return uniqueArray([

      ...oldValue,

      newValue

    ]);
  }


  // ----------------------------------------------------------
  // NEW ARRAY
  // ----------------------------------------------------------

  if (
    Array.isArray(
      newValue
    )
  ) {

    return uniqueArray([

      oldValue,

      ...newValue

    ]);
  }


  // ----------------------------------------------------------
  // BOTH OBJECTS
  // ----------------------------------------------------------

  if (
    isPlainObject(
      oldValue
    ) &&
    isPlainObject(
      newValue
    )
  ) {

    return deepMergeObjects(
      oldValue,
      newValue
    );
  }


  // ----------------------------------------------------------
  // SAME VALUE
  // ----------------------------------------------------------

  if (
    JSON.stringify(
      oldValue
    ) ===
    JSON.stringify(
      newValue
    )
  ) {

    return oldValue;
  }


  // ----------------------------------------------------------
  // DIFFERENT SCALAR VALUES
  // ----------------------------------------------------------

  return uniqueArray([

    oldValue,

    newValue

  ]);
}


// ============================================================
// DEEP MERGE OBJECTS
// ============================================================

function deepMergeObjects(
  a,
  b
) {

  const result = {
    ...a
  };


  for (
    const [
      key,
      value
    ] of Object.entries(b)
  ) {

    if (
      result[key] ===
      undefined
    ) {

      result[key] =
        value;

      continue;
    }


    result[key] =
      mergeValues(
        result[key],
        value
      );
  }


  return result;
}


// ============================================================
// BULK SUPABASE SAVE
// ============================================================

async function bulkSaveToSupabase(
  rows,
  env,
  budget
) {

  if (
    !rows ||
    rows.length === 0
  ) {

    return {

      saved:
        0,

      failed:
        0
    };
  }


  // ----------------------------------------------------------
  // ONLY ONE REQUEST
  // ----------------------------------------------------------

  budget.supabaseWrites++;


  const endpoint =
    `${env.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_TABLE}` +
    `?on_conflict=${encodeURIComponent(
      "application_id,source_url,field"
    )}`;


  const response =
    await fetch(
      endpoint,
      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "apikey":
            env.SUPABASE_SECRET_KEY,

          "Authorization":
            `Bearer ${env.SUPABASE_SECRET_KEY}`,

          "Prefer":
            "resolution=merge-duplicates,return=minimal"
        },

        body:
          JSON.stringify(
            rows
          )
      }
    );


  if (
    !response.ok
  ) {

    const errorText =
      await safeReadText(
        response
      );


    throw new Error(
      `Supabase bulk upsert failed: HTTP ${response.status} ${errorText}`
    );
  }


  return {

    saved:
      rows.length,

    failed:
      0
  };
}


// ============================================================
// DISCOVER WEBSITE URLS
// ============================================================

async function discoverWebsiteUrls(
  website,
  budget
) {

  const urls =
    new Set();


  const origin =
    new URL(
      website
    ).origin;


  // ----------------------------------------------------------
  // ALWAYS INCLUDE HOMEPAGE
  // ----------------------------------------------------------

  urls.add(
    normalizeUrl(
      website
    )
  );


  // ----------------------------------------------------------
  // SITEMAP CANDIDATES
  // ----------------------------------------------------------

  const sitemapCandidates = [

    `${origin}/sitemap.xml`,

    `${origin}/sitemap_index.xml`,

    `${origin}/wp-sitemap.xml`
  ];


  // ----------------------------------------------------------
  // ROBOTS.TXT
  // ----------------------------------------------------------

  if (
    budget.discoveryRequests <
    CONFIG.MAX_SITEMAPS
  ) {

    try {

      budget.discoveryRequests++;


      const robots =
        await fetchTextForDiscovery(
          `${origin}/robots.txt`
        );


      if (robots) {

        sitemapCandidates.push(
          ...extractSitemapsFromRobots(
            robots
          )
        );
      }

    } catch {

      // Ignore robots errors.
    }
  }


  // ----------------------------------------------------------
  // SITEMAP QUEUE
  // ----------------------------------------------------------

  const sitemapQueue =
    uniqueUrls(
      sitemapCandidates
    );


  const visitedSitemaps =
    new Set();


  let sitemapCount =
    0;


  // ==========================================================
  // PROCESS SITEMAPS
  // ==========================================================

  while (

    sitemapQueue.length > 0 &&

    sitemapCount <
      CONFIG.MAX_SITEMAPS &&

    urls.size <
      CONFIG.MAX_DISCOVERED_URLS

  ) {

    const sitemapUrl =
      sitemapQueue.shift();


    const normalizedSitemap =
      normalizeUrl(
        sitemapUrl
      );


    if (
      visitedSitemaps.has(
        normalizedSitemap
      )
    ) {

      continue;
    }


    visitedSitemaps.add(
      normalizedSitemap
    );


    sitemapCount++;


    try {

      budget.discoveryRequests++;


      const sitemapText =
        await fetchTextForDiscovery(
          normalizedSitemap
        );


      if (!sitemapText) {
        continue;
      }


      // ------------------------------------------------------
      // NESTED SITEMAPS
      // ------------------------------------------------------

      const nestedSitemaps =
        extractSitemapUrls(
          sitemapText
        );


      for (
        const nested of
        nestedSitemaps
      ) {

        if (
          !visitedSitemaps.has(
            normalizeUrl(
              nested
            )
          )
        ) {

          sitemapQueue.push(
            nested
          );
        }
      }


      // ------------------------------------------------------
      // PAGE URLS
      // ------------------------------------------------------

      const pageUrls =
        extractUrlsFromSitemap(
          sitemapText
        );


      for (
        const pageUrl of
        pageUrls
      ) {

        let normalized;


        try {

          normalized =
            normalizeUrl(
              pageUrl
            );

        } catch {

          continue;
        }


        // ----------------------------------------------------
        // SAME WEBSITE ONLY
        // ----------------------------------------------------

        if (
          !isSameOrigin(
            normalized,
            origin
          )
        ) {

          continue;
        }


        // ----------------------------------------------------
        // NEVER ADD XML/PDF/IMAGES ETC.
        // ----------------------------------------------------

        if (
          !isProcessablePageUrl(
            normalized
          )
        ) {

          continue;
        }


        urls.add(
          normalized
        );


        if (
          urls.size >=
          CONFIG.MAX_DISCOVERED_URLS
        ) {

          break;
        }
      }

    } catch {

      // Ignore individual sitemap failure.
    }
  }


  // ==========================================================
  // HOMEPAGE LINKS
  // ==========================================================

  // Only use homepage link discovery if we did not discover
  // enough pages from sitemaps.

  if (
    urls.size < 20
  ) {

    try {

      budget.discoveryRequests++;


      const homepageHtml =
        await fetchHtml(
          website,
          budget
        );


      const links =
        extractInternalLinks(
          homepageHtml,
          origin
        );


      for (
        const link of links
      ) {

        if (
          !isProcessablePageUrl(
            link
          )
        ) {

          continue;
        }


        urls.add(
          link
        );


        if (
          urls.size >=
          CONFIG.MAX_DISCOVERED_URLS
        ) {

          break;
        }
      }

    } catch {

      // Ignore homepage discovery errors.
    }
  }


  // ----------------------------------------------------------
  // FINAL FILTER
  // ----------------------------------------------------------

  return Array.from(
    urls
  )
    .filter(
      isProcessablePageUrl
    );
}


// ============================================================
// DISCOVERY TEXT FETCH
// ============================================================

async function fetchTextForDiscovery(
  url
) {

  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () =>
        controller.abort(),

      8000
    );


  try {

    const response =
      await fetch(
        url,
        {

          method:
            "GET",

          redirect:
            "follow",

          headers: {

            "User-Agent":
              CONFIG.USER_AGENT,

            "Accept":
              "application/xml,text/xml,text/plain"
          },

          signal:
            controller.signal
        }
      );


    if (
      !response.ok
    ) {

      return "";
    }


    const text =
      await response.text();


    return text.slice(
      0,
      5 * 1024 * 1024
    );

  } finally {

    clearTimeout(
      timeout
    );
  }
}


// ============================================================
// SITEMAP PAGE URL EXTRACTION
// ============================================================

function extractUrlsFromSitemap(
  xml
) {

  const matches =
    xml.match(
      /<loc>\s*([^<]+)\s*<\/loc>/gi
    ) || [];


  return matches
    .map(
      item => {

        const match =
          item.match(
            /<loc>\s*([^<]+)\s*<\/loc>/i
          );


        return match
          ? decodeXmlEntities(
              match[1].trim()
            )
          : null;
      }
    )
    .filter(Boolean);
}


// ============================================================
// NESTED SITEMAP EXTRACTION
// ============================================================

function extractSitemapUrls(
  xml
) {

  return extractUrlsFromSitemap(
    xml
  )
    .filter(
      url =>
        /\.xml(?:\.gz)?(?:\?|$)/i.test(
          url
        )
    );
}


// ============================================================
// ROBOTS.TXT SITEMAPS
// ============================================================

function extractSitemapsFromRobots(
  robots
) {

  return robots
    .split(
      /\r?\n/
    )
    .map(
      line => {

        const match =
          line.match(
            /^\s*Sitemap:\s*(\S+)/i
          );


        return match
          ? match[1].trim()
          : null;
      }
    )
    .filter(Boolean);
}


// ============================================================
// INTERNAL LINK EXTRACTION
// ============================================================

function extractInternalLinks(
  html,
  origin
) {

  const results =
    new Set();


  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;


  let match;


  while (
    (match =
      regex.exec(html)) !== null
  ) {

    const raw =
      match[1].trim();


    if (
      !raw ||
      raw.startsWith("#") ||
      raw.startsWith("mailto:") ||
      raw.startsWith("tel:") ||
      raw.startsWith("javascript:")
    ) {

      continue;
    }


    try {

      const url =
        new URL(
          raw,
          origin
        );


      if (
        url.origin !==
        origin
      ) {

        continue;
      }


      url.hash = "";


      // ------------------------------------------------------
      // REMOVE TRACKING
      // ------------------------------------------------------

      const trackingParams = [

        "utm_source",

        "utm_medium",

        "utm_campaign",

        "utm_term",

        "utm_content",

        "fbclid",

        "gclid"
      ];


      for (
        const param of
        trackingParams
      ) {

        url.searchParams.delete(
          param
        );
      }


      const normalized =
        normalizeUrl(
          url.toString()
        );


      if (
        isProcessablePageUrl(
          normalized
        )
      ) {

        results.add(
          normalized
        );
      }

    } catch {

      // Ignore invalid links.
    }
  }


  return Array.from(
    results
  );
}


// ============================================================
// PAGE URL FILTER
// ============================================================

function isProcessablePageUrl(
  url
) {

  try {

    const parsed =
      new URL(
        url
      );


    const pathname =
      parsed.pathname.toLowerCase();


    // --------------------------------------------------------
    // NEVER PROCESS SITEMAPS
    // --------------------------------------------------------

    if (
      pathname.endsWith(
        ".xml"
      ) ||
      pathname.endsWith(
        ".xml.gz"
      )
    ) {

      return false;
    }


    // --------------------------------------------------------
    // NEVER PROCESS OTHER FILES
    // --------------------------------------------------------

    for (
      const extension of
      NON_HTML_EXTENSIONS
    ) {

      if (
        pathname.endsWith(
          extension
        )
      ) {

        return false;
      }
    }


    return true;

  } catch {

    return false;
  }
}


// ============================================================
// PRIORITIZE HOMEPAGE
// ============================================================

function prioritizeHomepage(
  urls,
  homepage
) {

  const normalizedHomepage =
    normalizeUrl(
      homepage
    );


  const filtered =
    urls.filter(
      url =>
        url !==
        normalizedHomepage
    );


  return [

    normalizedHomepage,

    ...filtered
  ];
}


// ============================================================
// TEXT CHUNKING
// ============================================================

function splitTextIntoChunks(
  text,
  chunkSize,
  overlap
) {

  if (
    text.length <=
    chunkSize
  ) {

    return [
      text
    ];
  }


  const chunks =
    [];


  let start =
    0;


  while (
    start <
    text.length
  ) {

    let end =
      Math.min(
        start +
          chunkSize,

        text.length
      );


    // --------------------------------------------------------
    // FIND NATURAL BOUNDARY
    // --------------------------------------------------------

    if (
      end <
      text.length
    ) {

      const newline =
        text.lastIndexOf(
          "\n",
          end
        );


      const sentence =
        text.lastIndexOf(
          ". ",
          end
        );


      const boundary =
        Math.max(
          newline,
          sentence
        );


      if (
        boundary >
        start +
          chunkSize *
            0.7
      ) {

        end =
          boundary +
          1;
      }
    }


    const chunk =
      text
        .slice(
          start,
          end
        )
        .trim();


    if (
      chunk
    ) {

      chunks.push(
        chunk
      );
    }


    if (
      end >=
      text.length
    ) {

      break;
    }


    start =
      Math.max(
        0,
        end -
          overlap
      );
  }


  return chunks;
}


// ============================================================
// URL NORMALIZATION
// ============================================================

function normalizeWebsite(
  value
) {

  let input =
    value.trim();


  if (
    !/^https?:\/\//i.test(
      input
    )
  ) {

    input =
      "https://" +
      input;
  }


  const url =
    new URL(
      input
    );


  url.hash = "";


  return normalizeUrl(
    url.toString()
  );
}


// ============================================================
// NORMALIZE URL
// ============================================================

function normalizeUrl(
  value
) {

  const url =
    new URL(
      value
    );


  url.hash = "";


  const trackingParams = [

    "utm_source",

    "utm_medium",

    "utm_campaign",

    "utm_term",

    "utm_content",

    "fbclid",

    "gclid",

    "ref"
  ];


  for (
    const param of
    trackingParams
  ) {

    url.searchParams.delete(
      param
    );
  }


  let result =
    url.toString();


  // Remove trailing slash except homepage.
  if (
    url.pathname !== "/" &&
    result.endsWith("/")
  ) {

    result =
      result.slice(
        0,
        -1
      );
  }


  return result;
}


// ============================================================
// SAME ORIGIN
// ============================================================

function isSameOrigin(
  url,
  origin
) {

  try {

    return (
      new URL(
        url
      ).origin ===
      origin
    );

  } catch {

    return false;
  }
}


// ============================================================
// UNIQUE URLS
// ============================================================

function uniqueUrls(
  urls
) {

  const seen =
    new Set();


  const result =
    [];


  for (
    const url of urls
  ) {

    try {

      const normalized =
        normalizeUrl(
          url
        );


      if (
        !seen.has(
          normalized
        )
      ) {

        seen.add(
          normalized
        );


        result.push(
          normalized
        );
      }

    } catch {

      // Ignore invalid URL.
    }
  }


  return result;
}


// ============================================================
// HTML TAG MATCHER
// ============================================================

function matchTag(
  html,
  tag
) {

  const regex =
    new RegExp(
      `<${tag}[^>]*>([\\\\s\\\\S]*?)<\\\\/${tag}>`,
      "i"
    );


  const match =
    html.match(
      regex
    );


  if (!match) {

    return "";
  }


  return decodeHtmlEntities(
    match[1]
  )

    .replace(
      /<[^>]+>/g,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


// ============================================================
// HTML ENTITY DECODER
// ============================================================

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


// ============================================================
// XML ENTITY DECODER
// ============================================================

function decodeXmlEntities(
  text
) {

  return decodeHtmlEntities(
    text
  );
}


// ============================================================
// REMOVE REPEATED LINES
// ============================================================

function removeRepeatedLines(
  text
) {

  const lines =
    text
      .split(
        /\n+/
      )
      .map(
        line =>
          line.trim()
      )
      .filter(
        Boolean
      );


  const counts =
    new Map();


  for (
    const line of
    lines
  ) {

    if (
      line.length <
      3
    ) {

      continue;
    }


    counts.set(
      line,

      (
        counts.get(
          line
        ) || 0
      ) + 1
    );
  }


  return lines
    .filter(
      line => {

        const count =
          counts.get(
            line
          ) || 0;


        // Remove lines that appear many times
        // and are probably navigation/footer boilerplate.

        if (
          count >= 5 &&
          line.length < 200
        ) {

          return false;
        }


        return true;
      }
    )
    .join(
      "\n"
    );
}


// ============================================================
// UNIQUE ARRAY
// ============================================================

function uniqueArray(
  values
) {

  const result =
    [];


  for (
    const value of
    values
  ) {

    const exists =
      result.some(
        existing =>

          JSON.stringify(
            existing
          ) ===

          JSON.stringify(
            value
          )
      );


    if (!exists) {

      result.push(
        value
      );
    }
  }


  return result;
}


// ============================================================
// PLAIN OBJECT CHECK
// ============================================================

function isPlainObject(
  value
) {

  return (

    value !== null &&

    typeof value ===
      "object" &&

    !Array.isArray(
      value
    )
  );
}


// ============================================================
// JSON PARSER
// ============================================================

function parseJsonObject(
  text
) {

  const cleaned =
    text

      .replace(
        /^```json\s*/i,
        ""
      )

      .replace(
        /^```\s*/i,
        ""
      )

      .replace(
        /\s*```$/i,
        ""
      )

      .trim();


  // ----------------------------------------------------------
  // NORMAL JSON
  // ----------------------------------------------------------

  try {

    return JSON.parse(
      cleaned
    );

  } catch {

    // Continue.
  }


  // ----------------------------------------------------------
  // FIND JSON OBJECT
  // ----------------------------------------------------------

  const firstBrace =
    cleaned.indexOf(
      "{"
    );


  const lastBrace =
    cleaned.lastIndexOf(
      "}"
    );


  if (
    firstBrace >=
      0 &&

    lastBrace >
      firstBrace
  ) {

    const objectText =
      cleaned.slice(
        firstBrace,
        lastBrace +
          1
      );


    return JSON.parse(
      objectText
    );
  }


  throw new Error(
    "Could not parse Sarvam JSON."
  );
}


// ============================================================
// SAFE ERROR
// ============================================================

function safeError(
  error
) {

  if (
    error instanceof Error
  ) {

    return error.message;
  }


  return String(
    error
  );
}


// ============================================================
// SAFE RESPONSE TEXT
// ============================================================

async function safeReadText(
  response
) {

  try {

    const text =
      await response.text();


    return text.slice(
      0,
      2000
    );

  } catch {

    return "";
  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

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

        ...corsHeaders(),

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


// ============================================================
// CORS HEADERS
// ============================================================

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
