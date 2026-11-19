import MarkdownIt from "markdown-it";

function isSafeWebUrl(value: string) {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
	} catch {
		return false;
	}
}

export function createMessageMarkdownParser() {
	const markdown = new MarkdownIt({
		breaks: true,
		html: false,
		linkify: false,
		typographer: false,
	});

	markdown.validateLink = isSafeWebUrl;

	return markdown;
}

export function markdownToPlainText(markdown: MarkdownIt, content: string) {
	const parts: string[] = [];
	for (const token of markdown.parse(String(content || ""), {})) {
		if (token.type === "fence" || token.type === "code_block") {
			parts.push(token.content);
			continue;
		}
		for (const child of token.children || []) {
			if (child.type === "text" || child.type === "code_inline" || child.type === "image"
				|| child.type === "edgechat_link" || child.type === "edgechat_mention") {
				parts.push(child.content);
			} else if (child.type === "softbreak" || child.type === "hardbreak") {
				parts.push("\n");
			}
		}
		if (token.type === "inline") parts.push("\n");
	}
	return parts.join("").replace(/\s+/gu, " ").trim();
}
