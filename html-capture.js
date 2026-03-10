// Aceframe HTML Capture - DOM snapshot serialization
// Captures the current page's DOM as a JSON structure for interactive replay.
// Strips scripts, captures computed styles, converts relative URLs to absolute.

(function () {
  'use strict';

  // Size limit warning threshold (5MB)
  const SIZE_WARN_THRESHOLD = 5 * 1024 * 1024;

  // SVG namespace
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Attributes to strip (event handlers and script-related)
  const STRIP_ATTRS = /^on[a-z]+$/i;

  // Tags to skip entirely
  const SKIP_TAGS = new Set(['script', 'noscript']);

  // Inline tags that should not have their children omitted
  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);

  // Form element tags whose values we capture
  const FORM_TAGS = new Set(['input', 'textarea', 'select']);

  /**
   * Convert a relative URL to absolute using the current page's base URL
   */
  function toAbsoluteUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {
      return url;
    }
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  /**
   * Attributes whose values are URLs and should be made absolute
   */
  const URL_ATTRS = new Set([
    'src', 'href', 'action', 'poster', 'data', 'srcset',
    'background', 'cite', 'formaction', 'icon', 'manifest'
  ]);

  /**
   * Convert srcset attribute values to absolute URLs
   */
  function absolutizeSrcset(srcset) {
    if (!srcset) return srcset;
    return srcset.split(',').map(function (entry) {
      var parts = entry.trim().split(/\s+/);
      if (parts.length > 0) {
        parts[0] = toAbsoluteUrl(parts[0]);
      }
      return parts.join(' ');
    }).join(', ');
  }

  /**
   * Try to convert an image element to a data URL.
   * Returns the data URL or null if it fails (CORS, etc.)
   */
  function imageToDataUrl(img) {
    try {
      if (!img.complete || img.naturalWidth === 0) return null;
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      // CORS or tainted canvas - fall back to src
      return null;
    }
  }

  /**
   * Try to capture canvas element content as a data URL
   */
  function canvasToDataUrl(canvasEl) {
    try {
      return canvasEl.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  /**
   * Serialize a single DOM node into our JSON format.
   * Recursively serializes children.
   */
  function serializeNode(node, depth) {
    if (depth > 100) return null; // Prevent infinite recursion

    switch (node.nodeType) {
      case Node.ELEMENT_NODE:
        return serializeElement(node, depth);
      case Node.TEXT_NODE:
        return serializeText(node);
      case Node.DOCUMENT_TYPE_NODE:
        return null; // Handled separately
      case Node.COMMENT_NODE:
        return null; // Skip comments
      default:
        return null;
    }
  }

  /**
   * Serialize a text node
   */
  function serializeText(node) {
    var content = node.textContent;
    // Skip empty text nodes
    if (!content || content.trim().length === 0 && content.indexOf('\n') === -1) {
      // Keep whitespace-only text nodes that might affect layout (single spaces, etc.)
      if (content && content.length > 0) {
        return { type: 'text', content: content };
      }
      return null;
    }
    return { type: 'text', content: content };
  }

  /**
   * Serialize an element node
   */
  function serializeElement(el, depth) {
    var tag = el.tagName.toLowerCase();

    // Skip script and noscript tags entirely
    if (SKIP_TAGS.has(tag)) return null;

    // Build attributes object
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var attr = el.attributes[i];
      var name = attr.name;
      var value = attr.value;

      // Strip event handlers
      if (STRIP_ATTRS.test(name)) continue;

      // Strip javascript: URLs
      if (value && typeof value === 'string' && value.trim().toLowerCase().startsWith('javascript:')) {
        continue;
      }

      // Convert URL attributes to absolute
      if (URL_ATTRS.has(name)) {
        if (name === 'srcset') {
          value = absolutizeSrcset(value);
        } else {
          value = toAbsoluteUrl(value);
        }
      }

      // Convert style url() references to absolute
      if (name === 'style') {
        value = absolutizeStyleUrls(value);
      }

      attrs[name] = value;
    }

    var result = {
      type: 'element',
      tag: tag,
      attrs: attrs,
      children: []
    };

    // Handle SVG namespace
    if (el.namespaceURI === SVG_NS || tag === 'svg') {
      result.isSvg = true;
    }

    // Capture form element values
    if (FORM_TAGS.has(tag)) {
      if (tag === 'input') {
        var inputType = (el.type || 'text').toLowerCase();
        if (inputType === 'checkbox' || inputType === 'radio') {
          result.checked = el.checked;
        } else if (inputType !== 'file') {
          result.value = el.value;
        }
      } else if (tag === 'textarea') {
        result.value = el.value;
      } else if (tag === 'select') {
        result.selectedIndex = el.selectedIndex;
        result.value = el.value;
      }
    }

    // Handle special elements
    if (tag === 'canvas') {
      var dataUrl = canvasToDataUrl(el);
      if (dataUrl) {
        // Replace canvas with an image of its contents
        result.canvasDataUrl = dataUrl;
      }
    }

    if (tag === 'img') {
      // Try to inline small images, keep src for larger ones
      var imgDataUrl = imageToDataUrl(el);
      if (imgDataUrl && imgDataUrl.length < 100000) {
        // Only inline if under ~100KB to keep snapshot size manageable
        result.inlineDataUrl = imgDataUrl;
      }
    }

    // Handle style elements - capture their CSS text
    if (tag === 'style') {
      try {
        var sheet = el.sheet;
        if (sheet) {
          var cssText = '';
          for (var r = 0; r < sheet.cssRules.length; r++) {
            cssText += sheet.cssRules[r].cssText + '\n';
          }
          result.cssText = absolutizeStyleUrls(cssText);
        }
      } catch {
        // CORS restriction on stylesheet - fall through to text content
      }
    }

    // Handle link[rel=stylesheet] - try to capture the CSS
    if (tag === 'link' && el.rel === 'stylesheet') {
      try {
        var linkSheet = el.sheet;
        if (linkSheet) {
          var linkCss = '';
          for (var lr = 0; lr < linkSheet.cssRules.length; lr++) {
            linkCss += linkSheet.cssRules[lr].cssText + '\n';
          }
          result.cssText = absolutizeStyleUrls(linkCss);
          result.cssResolved = true;
        }
      } catch {
        // CORS - will try to fetch in collectStylesheets()
        result.cssResolved = false;
      }
    }

    // Handle shadow DOM
    if (el.shadowRoot) {
      result.shadowRoot = [];
      var shadowChildren = el.shadowRoot.childNodes;
      for (var s = 0; s < shadowChildren.length; s++) {
        var shadowChild = serializeNode(shadowChildren[s], depth + 1);
        if (shadowChild) result.shadowRoot.push(shadowChild);
      }
    }

    // Handle iframes
    if (tag === 'iframe') {
      try {
        var iframeDoc = el.contentDocument;
        if (iframeDoc && iframeDoc.documentElement) {
          result.iframeContent = serializeNode(iframeDoc.documentElement, depth + 1);
        }
      } catch {
        // Cross-origin iframe - can't access content
        result.iframeCrossOrigin = true;
      }
    }

    // Serialize children (skip for void tags)
    if (!VOID_TAGS.has(tag)) {
      var children = el.childNodes;
      for (var c = 0; c < children.length; c++) {
        var child = serializeNode(children[c], depth + 1);
        if (child) result.children.push(child);
      }
    }

    return result;
  }

  /**
   * Convert url() references in CSS to absolute URLs
   */
  function absolutizeStyleUrls(cssText) {
    if (!cssText) return cssText;
    return cssText.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, function (match, quote, url) {
      if (url.startsWith('data:') || url.startsWith('blob:')) return match;
      var absUrl = toAbsoluteUrl(url.trim());
      return 'url(' + quote + absUrl + quote + ')';
    });
  }

  /**
   * Collect all stylesheets and their CSS text.
   * For cross-origin sheets, attempts to fetch them with a timeout.
   * Fetches are parallelized for performance.
   */
  async function collectStylesheets() {
    var sheetEntries = [];

    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      var entry = {
        href: sheet.href ? toAbsoluteUrl(sheet.href) : null,
        media: sheet.media ? Array.from(sheet.media).join(', ') : '',
        disabled: sheet.disabled,
        cssText: null,
        resolved: false
      };

      try {
        // Try to read CSS rules directly (same-origin)
        var rules = sheet.cssRules || sheet.rules;
        var cssText = '';
        for (var r = 0; r < rules.length; r++) {
          cssText += rules[r].cssText + '\n';
        }
        entry.cssText = absolutizeStyleUrls(cssText);
        entry.resolved = true;
      } catch {
        // CORS - will fetch below
      }

      sheetEntries.push(entry);
    }

    // Fetch unresolved CORS stylesheets in parallel with timeout
    var fetchPromises = sheetEntries.map(function (entry, idx) {
      if (entry.resolved || !entry.href) return Promise.resolve();
      return fetch(entry.href, {
        credentials: 'omit',
        signal: AbortSignal.timeout(5000)
      })
        .then(function (response) {
          if (response.ok) return response.text();
          return null;
        })
        .then(function (text) {
          if (text) {
            entry.cssText = absolutizeStyleUrls(text);
            entry.resolved = true;
          }
        })
        .catch(function () {
          // Timeout or network error - skip this stylesheet
        });
    });

    await Promise.allSettled(fetchPromises);
    return sheetEntries;
  }

  /**
   * Get the document's doctype as a string
   */
  function getDoctype() {
    var doctype = document.doctype;
    if (!doctype) return '<!DOCTYPE html>';
    var str = '<!DOCTYPE ' + doctype.name;
    if (doctype.publicId) str += ' PUBLIC "' + doctype.publicId + '"';
    if (doctype.systemId) str += ' "' + doctype.systemId + '"';
    str += '>';
    return str;
  }

  /**
   * Main capture function - serializes the entire page into a snapshot object
   */
  async function captureHTML() {
    console.log('Aceframe: Starting HTML capture...');
    var startTime = performance.now();

    // Collect stylesheets (may involve async fetch for cross-origin)
    var stylesheets = await collectStylesheets();

    // Serialize the DOM tree
    var dom = serializeNode(document.documentElement, 0);

    var snapshot = {
      type: 'snapshot',
      version: 1,
      timestamp: Date.now(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX || window.pageXOffset || 0,
        scrollY: window.scrollY || window.pageYOffset || 0,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      url: window.location.href,
      title: document.title,
      baseUrl: document.baseURI,
      doctype: getDoctype(),
      dom: dom,
      stylesheets: stylesheets
    };

    // Check serialized size
    var serialized = JSON.stringify(snapshot);
    var sizeMB = (serialized.length / (1024 * 1024)).toFixed(2);
    var elapsed = (performance.now() - startTime).toFixed(0);

    console.log('Aceframe: HTML capture complete - ' + sizeMB + 'MB in ' + elapsed + 'ms');

    if (serialized.length > SIZE_WARN_THRESHOLD) {
      console.warn('Aceframe: HTML snapshot is large (' + sizeMB + 'MB). This may cause storage issues.');
      snapshot._sizeWarning = true;
      snapshot._sizeMB = parseFloat(sizeMB);
    }

    return snapshot;
  }

  // Expose the capture function globally for the background script to call
  window.__aceframeHTMLCapture = captureHTML;
})();
