// ============================================================
// AI BUSINESS WEBSITE KNOWLEDGE SCRAPER
// Cloudflare Worker + Sarvam 105B + Supabase
//
// MAIN FLOW:
//
// Website
//   ↓
// Discover pages
//   ↓
// Select small batch
//   ↓
// Fetch HTML
//   ↓
// Extract readable text
//   ↓
// Split very large pages into chunks
//   ↓
// Sarvam 105B extracts structured business facts
//   ↓
// Merge fields from all chunks
//   ↓
// ONE BULK SUPABASE UPSERT PER PAGE
//
// IMPORTANT:
// This Worker is designed for Cloudflare FREE limits.
//
// Cloudflare Free:
//   50 external subrequests / invocation
//
// We deliberately keep the batch small and control the
// maximum number of Sarvam requests.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {

  // ----------------------------------------------------------
  // BATCH SIZE
  // ----------------------------------------------------------

  // Number of pages processed in one Worker invocation.
  //
  // Example:
  // page_offset = 0 → pages 1-5
  // page_offset = 5 → pages 6-10
  // page_offset = 10 → pages 11-15
  //
  // Keep this around 3-5 on Cloudflare Free.
  MAX_PAGES_PER_INVOCATION: 5,

  // ----------------------------------------------------------
  // AI SAFETY LIMIT
  // ----------------------------------------------------------

  // Maximum number of Sarvam requests in one Worker invocation.
  //
  // This prevents a very large page from consuming all
  // Cloudflare subrequests.
  MAX_AI_CALLS_PER_INVOCATION: 20,

  // Maximum chunks allowed for one page.
  MAX_CHUNKS_PER_PAGE: 4,

  // ----------------------------------------------------------
  // TEXT CHUNKING
  // ----------------------------------------------------------

  // Character size of each chunk sent to Sarvam.
  //
  // 12,000 characters is deliberately conservative.
  // Sarvam 105B supports a much larger context window, but
  // smaller chunks make extraction more reliable and keep
  // Worker/API requests manageable.
  CHUNK_SIZE: 12000,

  // Overlap helps avoid losing facts at chunk boundaries.
  CHUNK_OVERLAP: 800,

  // ----------------------------------------------------------
  // WEBSITE FETCH
  // ----------------------------------------------------------

  // Maximum HTML downloaded from one page.
  MAX_HTML_BYTES: 2 * 1024 * 1024,

  // Timeout for website fetch.
  FETCH_TIMEOUT_MS: 12000,

  // ----------------------------------------------------------
  // DISCOVERY
  // ----------------------------------------------------------

  // Maximum URLs kept from sitemap/link discovery.
  MAX_DISCOVERED_URLS: 500,

  // Maximum sitemap files we will inspect.
  MAX_SITEMAPS: 10,

  // ----------------------------------------------------------
  // AI
  // ----------------------------------------------------------

  SARVAM_MODEL: "sarvam-105b",

  // Structured extraction does not need heavy reasoning.
  // Sarvam supports disabling reasoning for this kind of
  // latency/cost-sensitive extraction.
  REASONING_EFFORT: null,

  // ----------------------------------------------------------
  // SUPABASE
  // ----------------------------------------------------------

  SUPABASE_TABLE: "business_data",

  // ----------------------------------------------------------
  // USER AGENT
  // ----------------------------------------------------------

  USER_AGENT:
    "Mozilla/5.0 (compatible; AI-Business-Knowledge-Bot/1.0; +https://reportliai.sbs)"
};


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
    // ONLY POST
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
    // ENVIRONMENT VARIABLES
    // --------------------------------------------------------

    const requiredEnv = [
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
      "SARVAM_API_KEY"
    ];

    const missingEnv = requiredEnv.filter(
      key => !env[key]
    );

    if (missingEnv.length > 0) {
      return jsonResponse(
        {
          success: false,
          error: "Missing environment variables.",
          missing: missingEnv
        },
        500
      );
    }

    // --------------------------------------------------------
    // PARSE BODY
    // --------------------------------------------------------

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "Request body must be valid JSON."
        },
        400
      );
    }

    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    const applicationId =
      String(body.application_id || "").trim();

    const websiteInput =
      String(
        body.domain ||
        body.website ||
        body.website_url ||
        ""
      ).trim();

    const requestedMaxPages =
      Number(body.max_pages);

    const pageOffset =
      Math.max(
        0,
        Number.isFinite(Number(body.page_offset))
          ? Number(body.page_offset)
          : 0
      );

    // --------------------------------------------------------
    // VALIDATE APPLICATION ID
    // --------------------------------------------------------

    if (!applicationId) {
      return jsonResponse(
        {
          success: false,
          error: "application_id is required."
        },
        400
      );
    }

    // --------------------------------------------------------
    // VALIDATE WEBSITE
    // --------------------------------------------------------

    if (!websiteInput) {
      return jsonResponse(
        {
          success: false,
          error: "domain or website_url is required."
        },
        400
      );
    }

    // --------------------------------------------------------
    // NORMALIZE WEBSITE
    // --------------------------------------------------------

    let website;

    try {
      website = normalizeWebsite(websiteInput);
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "Invalid website URL."
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
      Number.isFinite(requestedMaxPages) &&
      requestedMaxPages > 0
    ) {
      pagesPerInvocation =
        Math.min(
          Math.floor(requestedMaxPages),
          CONFIG.MAX_PAGES_PER_INVOCATION
        );
    }

    // --------------------------------------------------------
    // SUBREQUEST BUDGET
    // --------------------------------------------------------

    const budget = {
      websiteFetches: 0,
      aiCalls: 0,
      supabaseWrites: 0,
      discoveryRequests: 0
    };

    // --------------------------------------------------------
    // DISCOVER WEBSITE URLS
    // --------------------------------------------------------

    let discoveredUrls = [];

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
          application_id: applicationId,
          website,
          error:
            "Website URL discovery failed.",
          details: safeError(error)
        },
        500
      );
    }

    // --------------------------------------------------------
    // FALLBACK
    // --------------------------------------------------------

    if (discoveredUrls.length === 0) {
      discoveredUrls = [website];
    }

    // --------------------------------------------------------
    // DEDUPLICATE
    // --------------------------------------------------------

    discoveredUrls =
      uniqueUrls(discoveredUrls)
        .slice(
          0,
          CONFIG.MAX_DISCOVERED_URLS
        );

    // --------------------------------------------------------
    // SELECT BATCH
    // --------------------------------------------------------

    const selectedUrls =
      discoveredUrls.slice(
        pageOffset,
        pageOffset + pagesPerInvocation
      );

    // --------------------------------------------------------
    // RESULT COUNTERS
    // --------------------------------------------------------

    const stats = {

      pages_discovered:
        discoveredUrls.length,

      pages_selected:
        selectedUrls.length,

      pages_processed: 0,

      pages_failed: 0,

      chunks_sent_to_ai: 0,

      fields_extracted: 0,

      fields_saved: 0,

      fields_failed: 0,

      sarvam_errors: 0
    };

    const pageResults = [];

    // --------------------------------------------------------
    // PROCESS EACH PAGE
    // --------------------------------------------------------

    for (const pageUrl of selectedUrls) {

      // ------------------------------------------------------
      // CHECK AI BUDGET
      // ------------------------------------------------------

      if (
        budget.aiCalls >=
        CONFIG.MAX_AI_CALLS_PER_INVOCATION
      ) {

        pageResults.push({
          url: pageUrl,
          success: false,
          error:
            "AI request budget reached. Continue with the next page_offset."
        });

        stats.pages_failed++;

        continue;
      }

      // ------------------------------------------------------
      // PROCESS PAGE
      // ------------------------------------------------------

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

        if (result.success) {

          stats.pages_processed++;

        } else {

          stats.pages_failed++;
        }

        pageResults.push(result);

      } catch (error) {

        stats.pages_failed++;

        pageResults.push({
          url: pageUrl,
          success: false,
          error: safeError(error)
        });
      }
    }

    // --------------------------------------------------------
    // PAGINATION
    // --------------------------------------------------------

    const nextOffset =
      pageOffset + selectedUrls.length;

    const hasMorePages =
      nextOffset < discoveredUrls.length;

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return jsonResponse(
      {
        success: true,

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

    url: pageUrl,

    success: false,

    chunks_sent_to_ai: 0,

    fields_extracted: 0,

    fields_saved: 0,

    fields_failed: 0,

    sarvam_errors: 0
  };


  // ----------------------------------------------------------
  // FETCH PAGE
  // ----------------------------------------------------------

  if (
    budget.websiteFetches >=
    CONFIG.MAX_PAGES_PER_INVOCATION
  ) {

    throw new Error(
      "Website fetch safety limit reached."
    );
  }

  const html =
    await fetchHtml(
      pageUrl,
      budget
    );


  // ----------------------------------------------------------
  // EXTRACT READABLE TEXT
  // ----------------------------------------------------------

  const pageData =
    extractReadableContent(
      html,
      pageUrl
    );


  // ----------------------------------------------------------
  // IF PAGE HAS LITTLE CONTENT
  // ----------------------------------------------------------

  if (
    !pageData.text ||
    pageData.text.length < 50
  ) {

    result.success = true;

    result.chunks_sent_to_ai = 0;

    result.fields_extracted = 0;

    result.fields_saved = 0;

    return result;
  }


  // ----------------------------------------------------------
  // CREATE CHUNKS
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
  // MERGED FIELDS FROM ALL CHUNKS
  // ----------------------------------------------------------

  const mergedFields =
    new Map();


  // ----------------------------------------------------------
  // PROCESS CHUNKS
  // ----------------------------------------------------------

  for (
    let chunkIndex = 0;
    chunkIndex < chunks.length;
    chunkIndex++
  ) {

    // --------------------------------------------------------
    // AI SAFETY LIMIT
    // --------------------------------------------------------

    if (
      budget.aiCalls >=
      CONFIG.MAX_AI_CALLS_PER_INVOCATION
    ) {

      break;
    }

    const chunk =
      chunks[chunkIndex];


    // --------------------------------------------------------
    // SEND TO SARVAM
    // --------------------------------------------------------

    let extracted;

    try {

      extracted =
        await extractWithSarvam(
          {
            url: pageUrl,
            title: pageData.title,
            chunk,
            chunkIndex,
            totalChunks: chunks.length
          },
          env,
          budget
        );

    } catch (error) {

      result.sarvam_errors++;

      continue;
    }


    // --------------------------------------------------------
    // COUNT
    // --------------------------------------------------------

    result.chunks_sent_to_ai++;


    // --------------------------------------------------------
    // MERGE FIELDS
    // --------------------------------------------------------

    for (
      const field of extracted
    ) {

      const normalized =
        normalizeField(
          field
        );

      if (!normalized) {
        continue;
      }


      result.fields_extracted++;


      // ------------------------------------------------------
      // MERGE SAME FIELD
      // ------------------------------------------------------

      if (
        mergedFields.has(
          normalized.field
        )
      ) {

        const previous =
          mergedFields.get(
            normalized.field
          );

        previous.data =
          mergeValues(
            previous.data,
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
  }


  // ----------------------------------------------------------
  // NO AI DATA
  // ----------------------------------------------------------

  if (
    mergedFields.size === 0
  ) {

    result.success =
      result.sarvam_errors === 0;

    return result;
  }


  // ----------------------------------------------------------
  // PREPARE BULK ROWS
  // ----------------------------------------------------------

  const rows = [];

  for (
    const item of mergedFields.values()
  ) {

    rows.push({

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
    });
  }


  // ----------------------------------------------------------
  // ONE SUPABASE WRITE
  // ----------------------------------------------------------

  try {

    const saved =
      await bulkSaveToSupabase(
        rows,
        env,
        budget
      );


    // --------------------------------------------------------
    // COUNT SUCCESSFUL ROWS
    // --------------------------------------------------------

    result.fields_saved =
      saved.saved;


    result.fields_failed =
      saved.failed;


    result.success =
      saved.failed === 0;

  } catch (error) {

    result.success = false;

    result.fields_failed =
      rows.length;

    result.error =
      safeError(error);
  }


  return result;
}


// ============================================================
// FETCH HTML
// ============================================================

async function fetchHtml(
  url,
  budget
) {

  budget.websiteFetches++;


  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      CONFIG.FETCH_TIMEOUT_MS
    );


  try {

    const response =
      await fetch(
        url,
        {
          method: "GET",

          redirect: "follow",

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


    if (!response.ok) {

      throw new Error(
        `Website returned HTTP ${response.status}`
      );
    }


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    // --------------------------------------------------------
    // ONLY HTML
    // --------------------------------------------------------

    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {

      throw new Error(
        `Not an HTML page: ${contentType}`
      );
    }


    // --------------------------------------------------------
    // SIZE CHECK
    // --------------------------------------------------------

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

    clearTimeout(timeout);
  }
}


// ============================================================
// EXTRACT READABLE CONTENT
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

      // Remove comments
      .replace(
        /<!--[\s\S]*?-->/g,
        " "
      )

      // Remove script
      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        " "
      )

      // Remove style
      .replace(
        /<style\b[^>]*>[\s\S]*?<\/style>/gi,
        " "
      )

      // Remove noscript
      .replace(
        /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
        " "
      )

      // Remove SVG
      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
        " "
      )

      // Remove canvas
      .replace(
        /<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi,
        " "
      )

      // Remove iframe
      .replace(
        /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
        " "
      )

      // Remove navigation
      .replace(
        /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
        " "
      )

      // Remove footer
      .replace(
        /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
        " "
      )

      // Remove aside
      .replace(
        /<aside\b[^>]*>[\s\S]*?<\/aside>/gi,
        " "
      )

      // Remove head
      .replace(
        /<head\b[^>]*>[\s\S]*?<\/head>/gi,
        " "
      );


  // ----------------------------------------------------------
  // ADD LINE BREAKS FOR IMPORTANT HTML ELEMENTS
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
  // DECODE COMMON HTML ENTITIES
  // ----------------------------------------------------------

  cleaned =
    decodeHtmlEntities(
      cleaned
    );


  // ----------------------------------------------------------
  // NORMALIZE WHITESPACE
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
  // LIMIT EXTREMELY LONG REPEATED BOILERPLATE
  // ----------------------------------------------------------

  cleaned =
    removeRepeatedLines(
      cleaned
    );


  return {

    url,

    title:
      cleanText(title),

    text:
      cleaned
  };
}


// ============================================================
// SARVAM AI EXTRACTION
// ============================================================

async function extractWithSarvam(
  page,
  env,
  budget
) {

  budget.aiCalls++;


  const systemPrompt = `
You are a website business-knowledge extraction engine.

Your job is to extract useful factual information from the
provided website text.

The extracted information will be stored in a database and later
used by AI employees such as:

- AI receptionist
- WhatsApp agent
- customer support agent
- sales agent
- appointment agent
- Gmail agent

IMPORTANT RULES:

1. Extract ONLY information explicitly present in the text.
2. NEVER invent information.
3. NEVER guess missing information.
4. Do not infer facts that are not stated.
5. Extract as much useful business information as possible.
6. Use meaningful lowercase snake_case field names.
7. Do not use useless field names such as:
   - text
   - section
   - content
   - data
   - information
   - unknown
   - miscellaneous
   - other
8. Preserve exact facts, names, prices, phone numbers,
   email addresses, addresses, URLs, service names and policies.
9. Combine related information into useful structured values.
10. If a value naturally contains multiple items, use an array.
11. If a value contains structured information, use an object.
12. Ignore website navigation.
13. Ignore cookie banners.
14. Ignore tracking information.
15. Ignore CSS.
16. Ignore JavaScript.
17. Ignore repeated footer/navigation boilerplate.
18. Do not create fields from empty or meaningless text.
19. Do not create duplicate fields with different names when
    they represent the same fact.
20. Extract information useful for answering real customer
    questions.

IMPORTANT FIELD EXAMPLES:

Good:

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
website
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

Bad:

text
page_text
section
content
unknown
data
misc
random_information

If multiple services are present, preserve ALL services.

If multiple doctors are present, preserve ALL doctors.

If multiple phone numbers are present, preserve ALL phone
numbers.

If multiple prices are present, preserve ALL prices.

If the page contains useful information that does not fit the
examples above, create a specific meaningful field name.

Do not summarize away important details.

Return JSON only.
`;


  const userPrompt = `
WEBSITE URL:
${page.url}

PAGE TITLE:
${page.title || "(no title)"}

CHUNK:
${page.chunkIndex + 1} of ${page.totalChunks}

WEBSITE CONTENT:
${page.chunk}

Extract every useful factual business fact from this content.
`;


  const response =
    await fetch(
      "https://api.sarvam.ai/v1/chat/completions",
      {

        method: "POST",

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
                role: "system",
                content: systemPrompt
              },

              {
                role: "user",
                content: userPrompt
              }

            ],

            temperature: 0.1,

            reasoning_effort:
              CONFIG.REASONING_EFFORT,

            max_tokens: 4096,

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

                          data: {

                            anyOf: [

                              {
                                type: "string"
                              },

                              {
                                type: "number"
                              },

                              {
                                type: "boolean"
                              },

                              {
                                type: "array",
                                items: {}
                              },

                              {
                                type: "object",
                                additionalProperties: true
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
  // HANDLE SARVAM ERROR
  // ----------------------------------------------------------

  if (!response.ok) {

    const errorText =
      await safeReadText(
        response
      );

    throw new Error(
      `Sarvam HTTP ${response.status}: ${errorText}`
    );
  }


  // ----------------------------------------------------------
  // PARSE RESPONSE
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
  // CONTENT MAY BE STRING
  // ----------------------------------------------------------

  let parsed;

  if (
    typeof content === "string"
  ) {

    try {

      parsed =
        JSON.parse(
          content
        );

    } catch {

      // Sometimes a model can return JSON surrounded by
      // accidental markdown. Try extracting the object.

      parsed =
        parseJsonObject(
          content
        );
    }

  } else {

    parsed = content;
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


  // ----------------------------------------------------------
  // FIELD NAME
  // ----------------------------------------------------------

  let field =
    String(
      item.field || ""
    )
      .trim()
      .toLowerCase();


  // ----------------------------------------------------------
  // NORMALIZE FIELD NAME
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


  // ----------------------------------------------------------
  // VALIDATE FIELD NAME
  // ----------------------------------------------------------

  if (
    !field ||
    field.length < 2
  ) {
    return null;
  }


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
    forbidden.has(field)
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


  // ----------------------------------------------------------
  // REMOVE EMPTY STRINGS
  // ----------------------------------------------------------

  if (
    typeof data === "string"
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
// MERGE VALUES FROM MULTIPLE AI CHUNKS
// ============================================================

function mergeValues(
  oldValue,
  newValue
) {

  // ----------------------------------------------------------
  // BOTH ARRAYS
  // ----------------------------------------------------------

  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return uniqueArray(
      [
        ...oldValue,
        ...newValue
      ]
    );
  }


  // ----------------------------------------------------------
  // OLD ARRAY
  // ----------------------------------------------------------

  if (
    Array.isArray(oldValue)
  ) {

    return uniqueArray(
      [
        ...oldValue,
        newValue
      ]
    );
  }


  // ----------------------------------------------------------
  // NEW ARRAY
  // ----------------------------------------------------------

  if (
    Array.isArray(newValue)
  ) {

    return uniqueArray(
      [
        oldValue,
        ...newValue
      ]
    );
  }


  // ----------------------------------------------------------
  // BOTH OBJECTS
  // ----------------------------------------------------------

  if (
    isPlainObject(oldValue) &&
    isPlainObject(newValue)
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
    JSON.stringify(oldValue) ===
    JSON.stringify(newValue)
  ) {

    return oldValue;
  }


  // ----------------------------------------------------------
  // DIFFERENT VALUES
  // ----------------------------------------------------------

  // Do NOT overwrite useful information.
  //
  // Example:
  //
  // chunk 1:
  // service_price = "₹500"
  //
  // chunk 2:
  // service_price = "₹1,000"
  //
  // Preserve both.

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
    const [key, value] of
    Object.entries(b)
  ) {

    if (
      result[key] === undefined
    ) {

      result[key] = value;

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
// BULK SAVE TO SUPABASE
// ============================================================

async function bulkSaveToSupabase(
  rows,
  env,
  budget
) {

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {

    return {
      saved: 0,
      failed: 0
    };
  }


  // ----------------------------------------------------------
  // ONE SUPABASE REQUEST
  // ----------------------------------------------------------

  budget.supabaseWrites++;


  const url =
    `${env.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_TABLE}` +
    `?on_conflict=${encodeURIComponent(
      "application_id,source_url,field"
    )}`;


  const response =
    await fetch(
      url,
      {

        method: "POST",

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


  if (!response.ok) {

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


  // ----------------------------------------------------------
  // ALWAYS INCLUDE HOMEPAGE
  // ----------------------------------------------------------

  urls.add(
    normalizeUrl(
      website
    )
  );


  // ----------------------------------------------------------
  // ORIGIN
  // ----------------------------------------------------------

  const origin =
    new URL(
      website
    ).origin;


  // ----------------------------------------------------------
  // SITEMAP URLS
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

      const robotsUrl =
        `${origin}/robots.txt`;


      budget.discoveryRequests++;


      const robots =
        await fetchTextForDiscovery(
          robotsUrl
        );


      if (robots) {

        const robotSitemaps =
          extractSitemapsFromRobots(
            robots
          );


        sitemapCandidates.push(
          ...robotSitemaps
        );
      }

    } catch {
      // Ignore robots.txt errors.
    }
  }


  // ----------------------------------------------------------
  // FETCH SITEMAPS
  // ----------------------------------------------------------

  const sitemapQueue =
    uniqueUrls(
      sitemapCandidates
    );


  const visitedSitemaps =
    new Set();


  let sitemapCount = 0;


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


    if (
      budget.discoveryRequests >=
      CONFIG.MAX_SITEMAPS + 1
    ) {
      break;
    }


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
      // SITEMAP INDEX
      // ------------------------------------------------------

      const nestedSitemaps =
        extractSitemapUrls(
          sitemapText
        );


      for (
        const nested of nestedSitemaps
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
        const pageUrl of pageUrls
      ) {

        const normalized =
          normalizeUrl(
            pageUrl
          );


        if (
          isSameOrigin(
            normalized,
            origin
          )
        ) {

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
      }

    } catch {
      // Ignore individual sitemap failures.
    }
  }


  // ----------------------------------------------------------
  // HOMEPAGE INTERNAL LINKS
  // ----------------------------------------------------------

  // If sitemap discovery did not give enough URLs, fetch the
  // homepage and collect internal links.
  //
  // This is intentionally done only once.

  if (
    urls.size <
    Math.min(
      50,
      CONFIG.MAX_DISCOVERED_URLS
    )
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
      // Homepage link discovery is optional.
    }
  }


  return Array.from(
    urls
  );
}


// ============================================================
// DISCOVERY FETCH
// ============================================================

async function fetchTextForDiscovery(
  url
) {

  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => controller.abort(),
      8000
    );


  try {

    const response =
      await fetch(
        url,
        {

          method: "GET",

          redirect: "follow",

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


    if (!response.ok) {
      return "";
    }


    const text =
      await response.text();


    // Keep sitemap discovery small.
    if (
      text.length >
      5 * 1024 * 1024
    ) {

      return text.slice(
        0,
        5 * 1024 * 1024
      );
    }


    return text;

  } finally {

    clearTimeout(timeout);
  }
}


// ============================================================
// EXTRACT SITEMAP URLS
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
// EXTRACT NESTED SITEMAPS
// ============================================================

function extractSitemapUrls(
  xml
) {

  return extractUrlsFromSitemap(
    xml
  )
    .filter(
      url =>
        /\.xml($|\?)/i.test(
          url
        )
    );
}


// ============================================================
// ROBOTS SITEMAPS
// ============================================================

function extractSitemapsFromRobots(
  robots
) {

  return robots
    .split(/\r?\n/)
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
// INTERNAL LINKS
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
    (match = regex.exec(html)) !== null
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
        url.origin !== origin
      ) {
        continue;
      }


      url.hash = "";


      // Remove tracking parameters.
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
        const param of trackingParams
      ) {

        url.searchParams.delete(
          param
        );
      }


      results.add(
        normalizeUrl(
          url.toString()
        )
      );

    } catch {
      // Ignore malformed URLs.
    }
  }


  return Array.from(
    results
  );
}


// ============================================================
// SPLIT TEXT INTO CHUNKS
// ============================================================

function splitTextIntoChunks(
  text,
  chunkSize,
  overlap
) {

  if (
    text.length <= chunkSize
  ) {

    return [text];
  }


  const chunks = [];


  let start = 0;


  while (
    start < text.length
  ) {

    let end =
      Math.min(
        start + chunkSize,
        text.length
      );


    // --------------------------------------------------------
    // TRY TO END AT A NATURAL BOUNDARY
    // --------------------------------------------------------

    if (
      end < text.length
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
        boundary > start + chunkSize * 0.7
      ) {

        end =
          boundary + 1;
      }
    }


    const chunk =
      text
        .slice(
          start,
          end
        )
        .trim();


    if (chunk) {
      chunks.push(
        chunk
      );
    }


    if (
      end >= text.length
    ) {
      break;
    }


    start =
      Math.max(
        0,
        end - overlap
      );
  }


  return chunks;
}


// ============================================================
// URL HELPERS
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


function normalizeUrl(
  value
) {

  const url =
    new URL(
      value
    );


  url.hash = "";


  // Remove common tracking parameters.
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
    const param of trackingParams
  ) {

    url.searchParams.delete(
      param
    );
  }


  // Remove trailing slash except root.
  let result =
    url.toString();


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


function isSameOrigin(
  url,
  origin
) {

  try {

    return (
      new URL(url).origin ===
      origin
    );

  } catch {

    return false;
  }
}


function uniqueUrls(
  urls
) {

  const seen =
    new Set();


  const result = [];


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
      // Ignore invalid URLs.
    }
  }


  return result;
}


// ============================================================
// HTML HELPERS
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
      .split(/\n+/)
      .map(
        line => line.trim()
      )
      .filter(Boolean);


  const counts =
    new Map();


  for (
    const line of lines
  ) {

    if (
      line.length < 3
    ) {
      continue;
    }


    counts.set(
      line,
      (counts.get(line) || 0) + 1
    );
  }


  return lines
    .filter(
      line => {

        const count =
          counts.get(
            line
          ) || 0;


        // Remove lines repeated many times,
        // which are usually navigation/boilerplate.
        if (
          count >= 5 &&
          line.length < 200
        ) {
          return false;
        }


        return true;
      }
    )
    .join("\n");
}


// ============================================================
// ARRAY HELPERS
// ============================================================

function uniqueArray(
  values
) {

  const result = [];


  for (
    const value of values
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
// OBJECT HELPERS
// ============================================================

function isPlainObject(
  value
) {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


// ============================================================
// JSON PARSING
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


  try {

    return JSON.parse(
      cleaned
    );

  } catch {
    // Continue.
  }


  const firstBrace =
    cleaned.indexOf(
      "{"
    );


  const lastBrace =
    cleaned.lastIndexOf(
      "}"
    );


  if (
    firstBrace >= 0 &&
    lastBrace > firstBrace
  ) {

    const objectText =
      cleaned.slice(
        firstBrace,
        lastBrace + 1
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
// CORS
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
