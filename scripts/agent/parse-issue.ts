// Parses the "Suggest a new tool" issue body into fields.
// Mirrors the `### Heading` extraction proven in triage-submissions.yml so both stay in sync.

export interface SubmissionFields {
    websiteUrl: string;
    toolName: string;
    description: string;
    category: string;
    pricingModel: string;
}

// First non-empty, non-comment line under a "### Heading".
export function field(body: string, heading: string): string {
    const capped = (body || '').slice(0, 20000);
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = capped.match(new RegExp(`### +${escaped}\\s*([\\s\\S]*?)(?=\\n### |\\n---|$)`, 'i'));
    return (match?.[1] || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean) || '';
}

export function parseIssue(body: string): SubmissionFields {
    return {
        websiteUrl: field(body, 'Website URL'),
        toolName: field(body, 'Tool name'),
        description: field(body, 'Description'),
        category: field(body, 'Category'),
        pricingModel: field(body, 'Pricing model'),
    };
}
