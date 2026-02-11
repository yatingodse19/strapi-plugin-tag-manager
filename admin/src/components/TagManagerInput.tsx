import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Field, Flex } from '@strapi/design-system';
import { useFetchClient } from '@strapi/admin/strapi-admin';

interface TagData {
  documentId: string;
  name: string;
}

interface TagManagerInputProps {
  attribute: { options?: Record<string, unknown> };
  description?: { id: string; defaultMessage: string };
  error?: string;
  hint?: string;
  label: string;
  labelAction?: React.ReactNode;
  name: string;
  onChange: (event: { target: { name: string; value: string; type: string } }) => void;
  required?: boolean;
  value?: unknown;
  disabled?: boolean;
}

function makeSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse tag value from Strapi. The value may arrive as:
 * - A JSON string (e.g. '[{"documentId":"abc","name":"Tag"}]')
 * - An already-parsed array (jsonb fields are pre-parsed by Strapi)
 * - null/undefined
 */
function parseTagValue(value: unknown): TagData[] {
  if (!value) return [];

  let data: unknown = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (Array.isArray(data)) {
    return data
      .filter((t: any) => t && typeof t === 'object' && t.name)
      .map((t: any) => ({
        documentId: t.documentId || '',
        name: String(t.name),
      }));
  }

  return [];
}

// Default tag content type — can be overridden via plugin config
const DEFAULT_TAG_UID = 'api::tag.tag';

const TagManagerInput: React.FC<TagManagerInputProps> = ({
  description,
  error,
  hint,
  label,
  labelAction,
  name,
  onChange,
  required,
  value,
  disabled,
}) => {
  const { get, post } = useFetchClient();
  const [tags, setTags] = useState<TagData[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<TagData[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isCreating, setIsCreating] = useState(false);
  const [dropdownFlip, setDropdownFlip] = useState(false);
  const [tagApiPath, setTagApiPath] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUserEdited = useRef(false);

  // Fetch plugin config to get tag content type UID
  useEffect(() => {
    (async () => {
      try {
        const resp = await get('/tag-manager/config');
        const uid = resp?.data?.tagContentType || DEFAULT_TAG_UID;
        setTagApiPath(`/content-manager/collection-types/${uid}`);
      } catch {
        // Plugin config endpoint not available — use default
        setTagApiPath(`/content-manager/collection-types/${DEFAULT_TAG_UID}`);
      }
    })();
  }, [get]);

  // Parse value from Strapi (handles both string and pre-parsed jsonb)
  useEffect(() => {
    if (hasUserEdited.current) return;
    const parsed = parseTagValue(value);
    if (parsed.length > 0) {
      setTags(parsed);
    }
  }, [value]);

  // Notify parent of changes
  const updateValue = useCallback(
    (newTags: TagData[]) => {
      hasUserEdited.current = true;
      setTags(newTags);
      onChange({
        target: {
          name,
          value: JSON.stringify(newTags),
          type: 'json',
        },
      });
    },
    [name, onChange]
  );

  // Check if dropdown should flip upward (not enough space below)
  const checkDropdownPosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    setDropdownFlip(spaceBelow < 220);
  }, []);

  // Search for tags via content-manager API
  const searchTags = useCallback(
    async (query: string) => {
      if (!query || query.length < 1 || !tagApiPath) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }
      try {
        const response = await get(
          `${tagApiPath}?page=1&pageSize=10&_q=${encodeURIComponent(query)}`
        );
        const results = response.data?.results || [];
        const selectedIds = new Set(tags.map((t) => t.documentId));
        const filtered = results
          .filter((t: any) => !selectedIds.has(t.documentId))
          .map((t: any) => ({
            documentId: t.documentId,
            name: t.name,
          }));
        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
        setSelectedIndex(-1);
        if (filtered.length > 0) checkDropdownPosition();
      } catch (err) {
        console.error('[tag-manager] Tag search failed:', err);
        setSuggestions([]);
      }
    },
    [get, tags, tagApiPath, checkDropdownPosition]
  );

  // Debounced search on input change
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => searchTags(val.trim()), 250);
    },
    [searchTags]
  );

  // Find or create a tag by name
  const findOrCreateTag = useCallback(
    async (tagName: string): Promise<TagData | null> => {
      const trimmed = tagName.trim();
      if (!trimmed || !tagApiPath) return null;

      if (tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
        return null;
      }

      setIsCreating(true);
      try {
        // Search for existing tag (case-insensitive)
        const searchResp = await get(
          `${tagApiPath}?page=1&pageSize=1&filters[$and][0][name][$eqi]=${encodeURIComponent(trimmed)}`
        );
        const existing = searchResp.data?.results || [];

        if (existing.length > 0) {
          return {
            documentId: existing[0].documentId,
            name: existing[0].name,
          };
        }

        // Create new tag
        const slug = makeSlug(trimmed);
        const createResp = await post(tagApiPath, { name: trimmed, slug });
        const created = createResp.data?.data || createResp.data;
        if (created?.documentId) {
          return { documentId: created.documentId, name: created.name || trimmed };
        }
        return null;
      } catch (err) {
        console.error('[tag-manager] Tag find/create failed:', err);
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    [get, post, tags, tagApiPath]
  );

  // Add a tag
  const addTag = useCallback(
    async (tagOrName: TagData | string) => {
      let tag: TagData | null = null;

      if (typeof tagOrName === 'string') {
        tag = await findOrCreateTag(tagOrName);
      } else {
        if (tags.find((t) => t.documentId === tagOrName.documentId)) return;
        tag = tagOrName;
      }

      if (tag) {
        updateValue([...tags, tag]);
      }
      setInputValue('');
      setSuggestions([]);
      setShowSuggestions(false);
      inputRef.current?.focus();
    },
    [tags, findOrCreateTag, updateValue]
  );

  // Remove a tag
  const removeTag = useCallback(
    (documentId: string) => {
      updateValue(tags.filter((t) => t.documentId !== documentId));
    },
    [tags, updateValue]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          addTag(suggestions[selectedIndex]);
        } else if (inputValue.trim()) {
          addTag(inputValue.trim());
        }
      } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
        removeTag(tags[tags.length - 1].documentId);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) =>
          Math.min(prev + 1, suggestions.length - 1)
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === 'Escape') {
        setShowSuggestions(false);
        setSelectedIndex(-1);
      }
    },
    [inputValue, selectedIndex, suggestions, tags, addTag, removeTag]
  );

  // Close suggestions on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <Field.Root
      name={name}
      id={name}
      error={error}
      hint={hint || description?.defaultMessage}
      required={required}
    >
      <Flex direction="column" alignItems="stretch" gap={1}>
        <Field.Label action={labelAction}>{label}</Field.Label>

        <div ref={containerRef} style={{ position: 'relative' }}>
          {/* Tag chips + input container */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px',
              padding: '6px 10px',
              border: `1px solid ${error ? '#d02b20' : '#dcdce4'}`,
              borderRadius: '4px',
              backgroundColor: disabled ? '#f6f6f9' : '#ffffff',
              minHeight: '40px',
              alignItems: 'center',
              cursor: disabled ? 'not-allowed' : 'text',
            }}
            onClick={() => !disabled && inputRef.current?.focus()}
          >
            {tags.map((tag) => (
              <span
                key={tag.documentId || tag.name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  backgroundColor: '#dcdce4',
                  borderRadius: '4px',
                  fontSize: '14px',
                  lineHeight: '20px',
                  whiteSpace: 'nowrap',
                }}
              >
                {tag.name}
                {!disabled && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTag(tag.documentId);
                    }}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '14px',
                      lineHeight: '1',
                      color: '#666687',
                      display: 'inline-flex',
                      alignItems: 'center',
                    }}
                    aria-label={`Remove ${tag.name}`}
                  >
                    &times;
                  </button>
                )}
              </span>
            ))}

            {!disabled && (
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  if (inputValue.trim() && suggestions.length > 0)
                    setShowSuggestions(true);
                }}
                placeholder={
                  tags.length === 0
                    ? 'Type tag name and press Enter...'
                    : ''
                }
                disabled={isCreating}
                style={{
                  border: 'none',
                  outline: 'none',
                  flex: 1,
                  minWidth: '120px',
                  fontSize: '14px',
                  lineHeight: '20px',
                  padding: '2px 0',
                  backgroundColor: 'transparent',
                }}
              />
            )}
          </div>

          {/* Autocomplete dropdown */}
          {showSuggestions && suggestions.length > 0 && (
            <div
              style={{
                position: 'absolute',
                ...(dropdownFlip
                  ? { bottom: '100%', marginBottom: '4px' }
                  : { top: '100%', marginTop: '4px' }),
                left: 0,
                right: 0,
                zIndex: 10,
                backgroundColor: '#ffffff',
                border: '1px solid #dcdce4',
                borderRadius: '4px',
                maxHeight: '200px',
                overflowY: 'auto',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
              }}
            >
              {suggestions.map((suggestion, index) => (
                <div
                  key={suggestion.documentId}
                  onClick={() => addTag(suggestion)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    backgroundColor:
                      index === selectedIndex ? '#f0f0ff' : 'transparent',
                    fontSize: '14px',
                  }}
                >
                  {suggestion.name}
                </div>
              ))}
            </div>
          )}
        </div>

        <Field.Hint />
        <Field.Error />
      </Flex>
    </Field.Root>
  );
};

export default TagManagerInput;
