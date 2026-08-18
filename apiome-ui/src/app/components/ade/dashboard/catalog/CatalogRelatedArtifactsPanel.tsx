'use client';

/**
 * Related artifacts panel for catalog item and project detail (MFI-6.4, #4410).
 *
 * Re-skinned in place by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html` §Related
 * artifacts: a `Card` with a titled header and the *Show all representations* link, one
 * `.list-row` per artifact (name, format and protocol pills, *Converted* / *Linked*, Unlink on
 * the trailing edge; a deleted one struck through), and a footer with *Suggest links* and the
 * dashed suggestion cards. The Catalog item detail mounts the same component, so it gets the
 * skin too; what it does — link, unlink, suggest — is unchanged.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Link2, Unlink, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { ProtocolPill } from '@/app/components/ui/catalog/ProtocolPill';
import {
  allRepresentationsHref,
  linkSourceLabel,
  relatedArtifactHref,
  type IdentitySuggestion,
  type RelatedArtifact,
} from '@/app/utils/catalog-related-artifacts';

export interface CatalogRelatedArtifactsPanelProps {
  projectId: string;
  identityGroupId?: string | null;
  relatedArtifacts?: RelatedArtifact[];
  readonly?: boolean;
  onChanged?: () => void;
}

export function CatalogRelatedArtifactsPanel({
  projectId,
  identityGroupId,
  relatedArtifacts: initialRelated = [],
  readonly = false,
  onChanged,
}: CatalogRelatedArtifactsPanelProps) {
  const [related, setRelated] = useState<RelatedArtifact[]>(initialRelated);
  const [suggestions, setSuggestions] = useState<IdentitySuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setRelated(initialRelated);
  }, [initialRelated]);

  const loadSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    try {
      const res = await fetch(`/api/identity/projects/${encodeURIComponent(projectId)}/suggestions`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to load suggestions');
      }
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
    } catch (error) {
      console.error(error);
      toast.error('Could not load link suggestions');
    } finally {
      setLoadingSuggestions(false);
    }
  }, [projectId]);

  const linkProject = useCallback(
    async (relatedProjectId: string) => {
      setBusyId(relatedProjectId);
      try {
        const res = await fetch('/api/identity/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, relatedProjectId }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Link failed');
        }
        setRelated(Array.isArray(data.relatedArtifacts) ? data.relatedArtifacts : []);
        setSuggestions((prev) => prev.filter((s) => s.projectId !== relatedProjectId));
        toast.success('Artifacts linked');
        onChanged?.();
      } catch (error) {
        console.error(error);
        toast.error(error instanceof Error ? error.message : 'Link failed');
      } finally {
        setBusyId(null);
      }
    },
    [projectId, onChanged],
  );

  const unlinkProject = useCallback(
    async (relatedProjectId: string) => {
      setBusyId(relatedProjectId);
      try {
        const res = await fetch('/api/identity/link', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, relatedProjectId }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Unlink failed');
        }
        setRelated(Array.isArray(data.relatedArtifacts) ? data.relatedArtifacts : []);
        toast.success('Artifact unlinked');
        onChanged?.();
      } catch (error) {
        console.error(error);
        toast.error(error instanceof Error ? error.message : 'Unlink failed');
      } finally {
        setBusyId(null);
      }
    },
    [projectId, onChanged],
  );

  const hasRelated = related.length > 0;

  return (
    <Card className="rart" data-testid="catalog-detail-related-artifacts">
      <div className="rart__header">
        <h2 className="rart__title">
          <Link2 aria-hidden />
          Related artifacts
        </h2>
        {identityGroupId ? (
          <Link
            href={allRepresentationsHref(identityGroupId)}
            className="rart__all"
            data-testid="catalog-show-all-representations"
          >
            Show all representations
          </Link>
        ) : null}
      </div>

      {hasRelated ? (
        <ul className="rart__list">
          {related.map((artifact) => (
            <li
              key={artifact.projectId}
              className={artifact.deleted ? 'rart__row rart__row--deleted' : 'rart__row'}
            >
              <div className="rart__body">
                <div className="rart__name">
                  {artifact.deleted ? (
                    <span className="rart__name-deleted">{artifact.name}</span>
                  ) : (
                    <Link href={relatedArtifactHref(artifact)} className="rart__link">
                      {artifact.name}
                    </Link>
                  )}
                </div>
                <div className="rart__meta">
                  {artifact.sourceFormat ? <FormatPill format={artifact.sourceFormat} /> : null}
                  {artifact.protocol ? <ProtocolPill protocol={artifact.protocol} /> : null}
                  <span>{artifact.deleted ? 'Deleted' : linkSourceLabel(artifact.linkSource)}</span>
                </div>
              </div>
              {!readonly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyId === artifact.projectId}
                  onClick={() => void unlinkProject(artifact.projectId)}
                  data-testid={`unlink-related-${artifact.projectId}`}
                >
                  <Unlink aria-hidden />
                  Unlink
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rart__empty">
          No linked artifacts yet. Link another format of this API to group representations together.
        </p>
      )}

      {!readonly ? (
        <div className="rart__footer">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rart__suggest"
            onClick={() => void loadSuggestions()}
            disabled={loadingSuggestions}
            data-testid="catalog-load-suggestions"
          >
            <Sparkles aria-hidden />
            {loadingSuggestions ? 'Loading suggestions…' : 'Suggest links'}
          </Button>
          {suggestions.length > 0 ? (
            <ul className="rart__suggestions" data-testid="catalog-identity-suggestions">
              {suggestions.map((suggestion) => (
                <li key={suggestion.projectId} className="rart__suggestion">
                  <div className="rart__body">
                    <p className="rart__suggestion-name">{suggestion.name}</p>
                    <p className="rart__suggestion-reason">
                      {suggestion.reason}
                      {suggestion.sourceFormat ? (
                        <>
                          {' · '}
                          <FormatPill format={suggestion.sourceFormat} />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === suggestion.projectId}
                    onClick={() => void linkProject(suggestion.projectId)}
                    data-testid={`link-suggestion-${suggestion.projectId}`}
                  >
                    <Link2 aria-hidden />
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export default CatalogRelatedArtifactsPanel;
