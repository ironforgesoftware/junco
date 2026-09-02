---
id: apply-pagination-fix-2026-08-31
priority: normal
timeout_minutes: 20
repo: ~/code/your-project
base_branch: main
pr_title: Fix off-by-one in pagination
draft: true
---

# Apply a pre-built patch series

```junco-patch
From 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b Mon Sep 17 00:00:00 2001
From: Jane Dev <jane@example.com>
Date: Sun, 30 Aug 2026 12:00:00 -0700
Subject: [PATCH] fix: correct off-by-one in page offset

---
 src/paginate.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/src/paginate.ts b/src/paginate.ts
index 1111111..2222222 100644
--- a/src/paginate.ts
+++ b/src/paginate.ts
@@ -10,7 +10,7 @@ export function paginate(items: Item[], page: number, size: number): Item[] {
-  const offset = page * size;
+  const offset = (page - 1) * size;
   return items.slice(offset, offset + size);
 }
--
2.43.0
```

## Verification

```bash
npx tsc --noEmit
```
