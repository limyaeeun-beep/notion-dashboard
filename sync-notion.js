// 노션 데이터베이스를 읽어서 data.json으로 저장하는 스크립트
// 실행: NOTION_TOKEN=secret_xxx NOTION_DATABASE_ID=xxx node sync-notion.js
//
// 2025-09-03 노션 API 변경(멀티 소스 데이터베이스) 대응:
// 1) database_id로 데이터소스 목록을 먼저 조회
// 2) 그 데이터소스 id로 실제 데이터를 쿼리

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = "2025-09-03";

if (!NOTION_TOKEN || !DATABASE_ID) {
  console.error("NOTION_TOKEN, NOTION_DATABASE_ID 환경변수가 필요합니다.");
  process.exit(1);
}

function authHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
}

// 노션 속성 타입별로 사람이 읽을 수 있는 값으로 변환
function extractValue(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
      return prop.title.map(t => t.plain_text).join("");
    case "rich_text":
      return prop.rich_text.map(t => t.plain_text).join("");
    case "select":
      return prop.select ? prop.select.name : "";
    case "status":
      return prop.status ? prop.status.name : "";
    case "multi_select":
      return prop.multi_select.map(s => s.name).join(", ");
    case "number":
      return prop.number ?? "";
    case "date":
      if (!prop.date) return "";
      if (prop.date.end) return prop.date.start + "~" + prop.date.end;
      return prop.date.start;
    case "people":
      return prop.people.map(p => p.name).join(", ");
    case "checkbox":
      return prop.checkbox;
    case "url":
      return prop.url || "";
    case "formula":
      return extractValue({ type: prop.formula.type, [prop.formula.type]: prop.formula[prop.formula.type] });
    case "rollup":
      if (prop.rollup.type === "array") {
        return prop.rollup.array.map(extractValue).join(", ");
      }
      return prop.rollup[prop.rollup.type] ?? "";
    default:
      return "";
  }
}

// 1단계: database_id로 데이터소스 id 목록 조회
async function getDataSourceIds() {
  const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
    method: "GET",
    headers: authHeaders()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`데이터베이스 조회 실패 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const dataSources = data.data_sources || [];
  if (dataSources.length === 0) {
    throw new Error("이 데이터베이스에 연결된 데이터소스를 찾을 수 없습니다.");
  }
  return dataSources.map(ds => ds.id);
}

// 2단계: 데이터소스 id로 실제 항목(행) 조회
async function fetchAllRowsFromDataSource(dataSourceId) {
  let results = [];
  let cursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(cursor ? { start_cursor: cursor } : {})
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`데이터소스 쿼리 실패 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    results = results.concat(data.results);
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }

  return results;
}

// 노션 속성 이름 -> 대시보드 필드 키 매핑
// 실제 노션 속성 이름과 다르면 이 객체의 왼쪽 값(노션 속성명)만 수정하세요.
const FIELD_MAP = {
  "작업코드": "code",
  "수신일": "recv",
  "매니저": "manager",
  "카테고리": "category",
  "타이틀": "title",
  "일감번호": "job",
  "작업일": "work",
  "MD": "md",
  "시안일": "draft",
  "오픈일": "open",
  "작업상태": "status",
  "종류": "kind"
};

function mapRow(page) {
  const row = {};
  for (const [notionName, key] of Object.entries(FIELD_MAP)) {
    const prop = page.properties[notionName];
    row[key] = extractValue(prop);
  }
  return row;
}

async function main() {
  console.log("데이터소스 ID 조회 중...");
  const dataSourceIds = await getDataSourceIds();
  console.log(`${dataSourceIds.length}개 데이터소스 발견`);

  let allPages = [];
  for (const id of dataSourceIds) {
    console.log(`데이터소스 ${id} 조회 중...`);
    const pages = await fetchAllRowsFromDataSource(id);
    allPages = allPages.concat(pages);
  }
  console.log(`${allPages.length}개 항목 발견`);

  const rows = allPages.map(mapRow);

  const output = {
    lastSynced: new Date().toISOString(),
    count: rows.length,
    rows
  };

  const fs = await import("fs");
  fs.writeFileSync("data.json", JSON.stringify(output, null, 2), "utf-8");
  console.log("data.json 저장 완료");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

