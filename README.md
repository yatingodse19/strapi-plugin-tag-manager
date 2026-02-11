# Strapi Plugin Tag Manager

A **tag bubbles input with autocomplete and auto-creation** for Strapi 5. Replaces the default relation picker for tags with a streamlined, Gmail-style tag input.

![Strapi 5](https://img.shields.io/badge/Strapi-5.x-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

## Features

- **Tag bubbles UI** — Visual tag chips with one-click removal
- **Autocomplete** — Search existing tags as you type (debounced, 250ms)
- **Auto-create** — New tags are created on the fly if they don't exist (with auto-generated slug)
- **Keyboard navigation** — Enter/comma to add, Backspace to remove last, Arrow keys to navigate suggestions, Escape to close
- **Smart dropdown** — Flips upward when near the bottom of the viewport, scrollable for many results
- **Pre-populated** — Displays existing tags when editing (handles both JSON strings and pre-parsed jsonb)
- **Unicode support** — Works with non-Latin scripts (Marathi, Hindi, Japanese, etc.)
- **Configurable** — Point to any collection type that has a `name` field

## Requirements

- Strapi 5.x
- A "Tag" (or similar) collection type with at least a `name` field and optionally a `slug` field

## Installation

### Option 1: Local Plugin (Recommended)

Copy the plugin into your Strapi project:

```bash
# From your Strapi project root
cp -r /path/to/strapi-plugin-tag-manager ./src/plugins/tag-manager
```

Or clone directly:

```bash
cd src/plugins
git clone https://github.com/yatingodse/strapi-plugin-tag-manager.git tag-manager
rm -rf tag-manager/.git  # Remove git history
```

### Option 2: Git Submodule

```bash
cd src/plugins
git submodule add https://github.com/yatingodse/strapi-plugin-tag-manager.git tag-manager
```

## Setup

### 1. Enable the Plugin

Add to `config/plugins.ts` (or `.js`):

```typescript
export default ({ env }) => ({
  // ... other plugins
  'tag-manager': {
    enabled: true,
    resolve: './src/plugins/tag-manager',
  },
});
```

### 2. Add the Custom Field to Your Content Type

In your content type's `schema.json` (e.g., `src/api/post/content-types/post/schema.json`):

```json
{
  "attributes": {
    "tagInput": {
      "type": "customField",
      "customField": "plugin::tag-manager.tags"
    }
  }
}
```

### 3. Restart Strapi

```bash
npm run develop
```

The `tagInput` field will appear in your content type's edit form.

## Configuration

### Custom Tag Content Type

By default, the plugin searches `api::tag.tag`. To use a different collection type:

```typescript
// config/plugins.ts
export default ({ env }) => ({
  'tag-manager': {
    enabled: true,
    resolve: './src/plugins/tag-manager',
    config: {
      tagContentType: 'api::label.label',  // Your custom tag collection
    },
  },
});
```

Your collection type must have:
- A `name` field (string, required) — used for display and search
- A `slug` field (optional) — auto-generated when creating new tags

## Syncing Tags to a Relation

The `tagInput` field stores tags as JSON: `[{documentId: "abc", name: "Tag Name"}, ...]`

To keep this in sync with a manyToMany `tags` relation (for use in frontend queries), add lifecycle hooks to your content type:

### Example: `src/api/post/content-types/post/lifecycles.ts`

```typescript
import slugify from 'slugify';

let isSyncingTags = false;

function parseTagInput(input: unknown): Array<{ documentId?: string; name: string }> {
  if (!input) return [];
  let data: unknown = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); } catch { return []; }
  }
  if (Array.isArray(data)) {
    return data
      .filter((t: any) => t && typeof t === 'object' && t.name)
      .map((t: any) => ({ documentId: t.documentId || undefined, name: String(t.name).trim() }))
      .filter((t) => t.name.length > 0);
  }
  return [];
}

async function resolveTagDocumentIds(
  tagEntries: Array<{ documentId?: string; name: string }>
): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of tagEntries) {
    if (entry.documentId) { ids.push(entry.documentId); continue; }
    const slug = slugify(entry.name, { lower: true, strict: true, trim: true });
    const existing = await strapi.documents('api::tag.tag').findMany({
      filters: { $or: [{ name: { $eqi: entry.name } }, { slug: { $eq: slug } }] },
      limit: 1,
    });
    if (existing.length > 0) {
      ids.push(existing[0].documentId);
    } else {
      const newTag = await strapi.documents('api::tag.tag').create({ data: { name: entry.name, slug } });
      ids.push(newTag.documentId);
    }
  }
  return [...new Set(ids)];
}

async function syncTagsViaJoinTable(postDocumentId: string, tagDocumentIds: string[]) {
  const knex = strapi.db.connection;
  const postRows = await knex('posts').select('id').where('document_id', postDocumentId);
  if (postRows.length === 0) return;

  const tagRows = await knex('tags').select('id').whereIn('document_id', tagDocumentIds);
  const tagNumericIds = tagRows.map((r: { id: number }) => r.id);

  for (const postRow of postRows) {
    await knex('posts_tags_lnk').where('post_id', postRow.id).del();
    if (tagNumericIds.length > 0) {
      const rows = tagNumericIds.map((tagId: number, idx: number) => ({
        post_id: postRow.id,
        tag_id: tagId,
        tag_ord: idx + 1,
        post_ord: idx + 1,
      }));
      await knex('posts_tags_lnk').insert(rows);
    }
  }
}

export default {
  async afterCreate(event) {
    if (isSyncingTags) return;
    const { result, params: { data } } = event;
    if (!data.tagInput) return;

    const tagEntries = parseTagInput(data.tagInput);
    if (tagEntries.length === 0) return;

    const tagDocIds = await resolveTagDocumentIds(tagEntries);
    const postDocumentId = result.documentId as string;

    // Defer: afterCreate runs inside an uncommitted transaction
    setTimeout(async () => {
      isSyncingTags = true;
      try { await syncTagsViaJoinTable(postDocumentId, tagDocIds); }
      catch (err) { console.error('[tag-sync] afterCreate error:', err); }
      finally { isSyncingTags = false; }
    }, 100);
  },

  async afterUpdate(event) {
    if (isSyncingTags) return;
    const { result, params: { data } } = event;
    if (!data.tagInput) return;

    const tagEntries = parseTagInput(data.tagInput);
    if (tagEntries.length === 0) return;

    isSyncingTags = true;
    try {
      const tagDocIds = await resolveTagDocumentIds(tagEntries);
      await syncTagsViaJoinTable(result.documentId as string, tagDocIds);
    } catch (err) { console.error('[tag-sync] afterUpdate error:', err); }
    finally { isSyncingTags = false; }
  },
};
```

> **Why Knex instead of `strapi.documents`?** Setting relation data in Strapi 5 lifecycle hooks causes deadlocks and expects numeric IDs. Direct join table manipulation via Knex avoids both issues.

> **Why `setTimeout` in `afterCreate`?** The hook runs inside an uncommitted DB transaction. The post row doesn't exist yet from Knex's perspective (different connection). Deferring 100ms lets the transaction commit first.

### Backfill Existing Data

If you have existing posts with tags in a manyToMany relation, backfill the `tagInput` field:

```sql
UPDATE posts p
SET tag_input = (
  SELECT jsonb_agg(
    jsonb_build_object('documentId', t.document_id, 'name', t.name)
    ORDER BY lnk.tag_ord
  )
  FROM posts_tags_lnk lnk
  JOIN tags t ON t.id = lnk.tag_id
  WHERE lnk.post_id = p.id
)
WHERE tag_input IS NULL
  AND EXISTS (SELECT 1 FROM posts_tags_lnk lnk WHERE lnk.post_id = p.id);
```

## Data Format

The field stores a JSON array in the database (`jsonb` column):

```json
[
  { "documentId": "abc123", "name": "JavaScript" },
  { "documentId": "def456", "name": "React" },
  { "documentId": "ghi789", "name": "Strapi" }
]
```

## Hiding the Default Relation Picker

If you keep both `tagInput` and a `tags` relation on the same content type, you can hide the relation picker from the edit view by updating the layout configuration in the database:

```sql
-- Remove 'tags' from the edit layout and set visible: false
UPDATE strapi_core_store_settings
SET value = jsonb_set(
  value::jsonb,
  '{metadatas,tags,edit,visible}',
  'false'
)
WHERE key = 'plugin_content_manager_configuration_content_types::api::post.post';
```

Then manually adjust the `layouts.edit` array in the same row to remove the `tags` entry.

> Note: `pluginOptions.content-manager.visible: false` in the schema does NOT hide relation fields in Strapi 5.

## Troubleshooting

### Tags not showing on existing entries

The `tagInput` field value arrives as a pre-parsed JavaScript array from Strapi (jsonb), not as a JSON string. The plugin handles both formats. If tags still don't appear, check:

1. The `tag_input` column has data: `SELECT tag_input FROM your_table WHERE id = X;`
2. The data format is `[{"documentId": "...", "name": "..."}]`

### Autocomplete not finding tags

The plugin uses the Content Manager API which requires admin authentication. Ensure:

1. You're logged into the Strapi admin
2. The tag content type exists and has entries

### Custom field not found on startup

Server-side plugin code must be JavaScript (`.js`), not TypeScript (`.ts`). Strapi's develop mode does not compile plugin server TypeScript.

## License

MIT

## Credits

Built for [Bobhata.com](https://bobhata.com) — a Marathi infotainment portal.
