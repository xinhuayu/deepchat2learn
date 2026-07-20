import io
import json
import re
import sys

import pdfplumber


MAX_TABLES = 50
MAX_ROWS = 100
MAX_CELLS = 40
CAPTION_PATTERN = re.compile(r"^(Table|Tab\.|Figure|Fig\.|Exhibit)\s+([0-9A-Za-z]+)\b\s*(.*)$", re.IGNORECASE)


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def caption_record(line, page_number):
    match = CAPTION_PATTERN.match(clean_text(line))
    if not match:
        return None
    prefix = match.group(1).lower()
    kind = "table" if prefix in {"table", "tab."} else "figure" if prefix in {"figure", "fig."} else "exhibit"
    label = f"{match.group(1)} {match.group(2)}"
    return {"kind": kind, "label": label, "page": page_number, "text": clean_text(line)}


def extract():
    data = sys.stdin.buffer.read()
    pages = []
    tables = []
    captions = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(x_tolerance=1, y_tolerance=3, layout=True) or ""
            page_captions = [caption for line in text.splitlines() if (caption := caption_record(line, page_number))]
            captions.extend(page_captions)
            page_tables = []
            try:
                page_tables = page.extract_tables() or []
            except Exception:
                page_tables = []
            for table_index, raw_table in enumerate(page_tables, start=1):
                rows = []
                for raw_row in raw_table[:MAX_ROWS]:
                    row = [clean_text(cell) for cell in (raw_row or [])[:MAX_CELLS]]
                    if any(row):
                        rows.append(row)
                if not rows:
                    continue
                table_id = f"table-{len(tables) + 1}"
                caption = next((item["text"] for item in page_captions if item["kind"] == "table"), None)
                table_text = "\n".join(" | ".join(row) for row in rows)
                record = {
                    "tableId": table_id,
                    "page": page_number,
                    "caption": caption,
                    "rows": rows,
                    "text": table_text,
                }
                tables.append(record)
                if len(tables) >= MAX_TABLES:
                    break
            pages.append({"page": page_number, "text": text})
            if len(tables) >= MAX_TABLES:
                # Continue collecting page text and captions, but stop table work.
                continue
    return {"pageCount": len(pages), "pages": pages, "tables": tables[:MAX_TABLES], "captions": captions[:200]}


if __name__ == "__main__":
    try:
        sys.stdout.buffer.write(json.dumps(extract(), ensure_ascii=False).encode("utf-8"))
    except Exception as error:
        sys.stdout.buffer.write(json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8"))
        sys.exit(1)
