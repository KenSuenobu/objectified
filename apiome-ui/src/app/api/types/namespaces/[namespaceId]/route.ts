import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedTenantContext,
  proxyRestDelete,
  proxyRestPut,
} from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/types/namespaces/[namespaceId]
 *
 * Update a tenant namespace's base URI, version root, description, or default flag (Namespaces
 * UI #3471 / API #3451). The namespace path itself is immutable; system-core namespaces are
 * read-only and the REST layer rejects them with 403.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ namespaceId: string }> }
) {
  try {
    const { namespaceId } = await params;
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = await request.json();

    const { data, error, status } = await proxyRestPut(
      ctx.user,
      `/types/${encodeURIComponent(ctx.tenantSlug)}/namespaces/${encodeURIComponent(namespaceId)}`,
      body
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, namespace: data });
  } catch (error) {
    console.error('Error updating type namespace:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/types/namespaces/[namespaceId]
 *
 * Unregister a tenant namespace. The namespace list is referential — a type's namespace is a plain
 * string on the primitive — so this removes the registration only: the types keep their namespace
 * and reappear as "unregistered" on the Primitives dashboard. System-core namespaces are read-only
 * and the REST layer rejects them with 403.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ namespaceId: string }> }
) {
  try {
    const { namespaceId } = await params;
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { data, error, status } = await proxyRestDelete(
      ctx.user,
      `/types/${encodeURIComponent(ctx.tenantSlug)}/namespaces/${encodeURIComponent(namespaceId)}`
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    const result = (data ?? {}) as { namespace?: string; unregistered_type_count?: number };
    return NextResponse.json({
      success: true,
      namespace: result.namespace ?? null,
      unregisteredTypeCount: result.unregistered_type_count ?? 0,
    });
  } catch (error) {
    console.error('Error deleting type namespace:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
