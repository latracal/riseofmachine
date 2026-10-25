// Fetches a submitted URL and deterministically verifies it is live and real.
// No LLM here — only network + HTML heuristics. The AI/ML judgement happens in judge.ts.

import { parse } from 'node-html-parser';

const TIMEOUT_MS = 10000;
const MAX_BYTES = 500_000;
const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PARKED_MARKERS = [
    'domain is for sale',
    'buy this domain',
    'parked by',
    'domain parking',
    'this domain is for sale',
    'godaddy.com/domainsearch',
    'hugedomains.com',
    'sedoparking.com',
];

export interface SiteResult {
    ok: boolean;
    reason?: string;
    finalUrl?: string;
    title?: string;
    description?: string;
    ogTitle?: string;
    ogDescription?: string;
    textSample?: string;
}

function fail(reason: string): SiteResult {
    return { ok: false, reason };
}

// Block SSRF to loopback, link-local, cloud-metadata, and RFC 1918 private ranges. The triage
// gate only checks "https + dotted host", so IP literals like 169.254.169.254 would pass.
function isBlockedHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === 'metadata' || host === 'metadata.google.internal') return true;
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;

    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 0 || a === 10 || a === 127) return true;          // this-net, private, loopback
        if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;           // private
        if (a === 192 && b === 168) return true;                    // private
        if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    }
    return false;
}

export async function fetchSite(url: string): Promise<SiteResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return fail('Submitted URL is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return fail('URL must use http or https.');
    }
    if (isBlockedHost(parsed.hostname)) {
        return fail('URL points to a private or internal host.');
    }

    const attempt = async (): Promise<SiteResult> => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const response = await fetch(parsed.toString(), {
                headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
                redirect: 'follow',
                signal: controller.signal,
            });

            if (!response.ok) {
                return fail(`Site returned HTTP ${response.status}.`);
            }

            // A public URL can redirect to an internal one; re-check the resolved host.
            try {
                if (response.url && isBlockedHost(new URL(response.url).hostname)) {
                    return fail('URL redirected to a private or internal host.');
                }
            } catch {
                /* non-parseable response.url — ignore */
            }

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('text/html')) {
                return fail(`Expected an HTML page but got "${contentType || 'unknown'}".`);
            }

            const raw = await response.text();
            const html = raw.slice(0, MAX_BYTES);
            const lower = html.toLowerCase();

            if (PARKED_MARKERS.some((m) => lower.includes(m))) {
                return fail('Domain looks parked or for sale, not a live product.');
            }

            const root = parse(html);
            const title = root.querySelector('title')?.text?.trim() || '';
            const ogTitle =
                root.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
            const description =
                root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
            const ogDescription =
                root.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() || '';

            root.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());
            const visibleText = root.querySelector('body')?.text?.replace(/\s+/g, ' ').trim() || '';

            if (!title && !ogTitle && visibleText.length < 50) {
                return fail('Page has almost no readable content.');
            }

            return {
                ok: true,
                finalUrl: response.url || parsed.toString(),
                title,
                description,
                ogTitle,
                ogDescription,
                textSample: visibleText.slice(0, 4000),
            };
        } finally {
            clearTimeout(timeoutId);
        }
    };

    try {
        return await attempt();
    } catch (err: any) {
        // One retry for transient network/abort failures.
        try {
            return await attempt();
        } catch (err2: any) {
            const msg = err2?.name === 'AbortError' ? 'Request timed out.' : (err2?.message || 'Network error.');
            return fail(`Could not reach the site: ${msg}`);
        }
    }
}
