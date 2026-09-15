import { marked } from "marked";
import DOMPurify from "dompurify";
import { resolveSource } from "./domain.js";
export function renderMarkdown(
  element,
  text,
  source = "",
  assets = [],
  onAsset = () => {},
) {
  element.innerHTML = DOMPurify.sanitize(
    marked.parse(text || "", { gfm: true, breaks: false }),
    {
      FORBID_TAGS: [
        "img",
        "svg",
        "iframe",
        "style",
        "video",
        "audio",
        "form",
        "input",
        "button",
      ],
      FORBID_ATTR: ["style", "srcset"],
    },
  );
  for (const a of element.querySelectorAll("a")) {
    const href = a.getAttribute("href") || "",
      key = resolveSource(source, href),
      asset = assets.find((a) => a.source_key === key);
    if (asset) {
      a.href = "#";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        onAsset(asset);
      });
    } else if (/^https?:\/\//i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.referrerPolicy = "no-referrer";
    } else {
      a.removeAttribute("href");
      a.title = "Original relative reference: " + href;
    }
  }
}
