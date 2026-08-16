'use client';

import { useState, useEffect } from 'react';
import {
  Package,
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  X,
  Search,
  Star,
  Power,
  Eye,
  Tag,
  Copy,
  MoreVertical,
} from 'lucide-react';
import { SkeletonTableRows } from '@/app/components/ui/Skeleton';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { destructiveConfirm } from '@/app/components/dialogs/destructiveConfirm';
import {
  getAllPropertyTemplates,
  getPropertyTemplateStats,
  getPropertyTemplateCategoriesAdmin,
  createPropertyTemplateAdmin,
  updatePropertyTemplateAdmin,
  deletePropertyTemplateAdmin,
  togglePropertyTemplateStatus,
} from '../../../../../lib/db/admin-helper';

/**
 * Placeholder bar width per column of the templates table, in header order — template,
 * category, type, schema type, usage, status, actions.
 *
 * Stated per column rather than uniformly because a row of identical grey bars is a spinner
 * with extra steps: the shape has to be the shape of the answer (DESIGN.md §8).
 */
const TEMPLATE_SKELETON_COLUMNS = ['45%', '6rem', '5rem', '7rem', '3rem', '4.5rem', ''] as const;

interface PropertyTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  schema: any;
  tags: string[];
  tenant_id: string | null;
  created_by: string | null;
  is_system: boolean;
  is_public: boolean;
  usage_count: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  tenant_name?: string;
  creator_name?: string;
  creator_email?: string;
}

interface TemplateStats {
  total_templates: number;
  system_templates: number;
  tenant_templates: number;
  enabled_templates: number;
  disabled_templates: number;
  total_usage: number;
  category_count: number;
}

interface CategoryStats {
  category: string;
  count: number;
  system_count: number;
  tenant_count: number;
}

// Category display configuration
const categoryConfig: Record<string, { label: string; icon: string; color: string }> = {
  identifiers: { label: 'Identifiers', icon: '🔑', color: 'bg-blue-100 text-blue-700' },
  timestamps: { label: 'Timestamps', icon: '⏰', color: 'bg-purple-100 text-purple-700' },
  audit: { label: 'Audit Fields', icon: '📋', color: 'bg-amber-100 text-amber-700' },
  status: { label: 'Status Fields', icon: '🚦', color: 'bg-green-100 text-green-700' },
  contact: { label: 'Contact Info', icon: '📧', color: 'bg-cyan-100 text-cyan-700' },
  address: { label: 'Address Fields', icon: '📍', color: 'bg-red-100 text-red-700' },
  money: { label: 'Money & Currency', icon: '💰', color: 'bg-emerald-100 text-emerald-700' },
  geolocation: { label: 'Geolocation', icon: '🌍', color: 'bg-teal-100 text-teal-700' },
  i18n: { label: 'Internationalization', icon: '🌐', color: 'bg-indigo-100 text-indigo-700' },
  pagination: { label: 'Pagination', icon: '📄', color: 'bg-orange-100 text-orange-700' },
  search: { label: 'Search & Filter', icon: '🔍', color: 'bg-pink-100 text-pink-700' },
};

const getCategoryConfig = (category: string) => {
  return categoryConfig[category] || {
    label: category.charAt(0).toUpperCase() + category.slice(1),
    icon: '📦',
    color: 'bg-gray-100 text-gray-700'
  };
};

const defaultSchema = {
  type: 'string',
  description: '',
  example: ''
};

export default function PropertyTemplateManagementClient() {
  const { confirm } = useDialog();
  const [templates, setTemplates] = useState<PropertyTemplate[]>([]);
  const [filteredTemplates, setFilteredTemplates] = useState<PropertyTemplate[]>([]);
  const [stats, setStats] = useState<TemplateStats | null>(null);
  const [categories, setCategories] = useState<CategoryStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showSystemOnly, setShowSystemOnly] = useState(false);
  const [showTenantOnly, setShowTenantOnly] = useState(false);

  // Dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<PropertyTemplate | null>(null);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category: 'identifiers',
    customCategory: '',
    schema: JSON.stringify(defaultSchema, null, 2),
    tags: '',
    isSystem: true,
    isPublic: true,
  });
  const [useCustomCategory, setUseCustomCategory] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    filterTemplates();
  }, [templates, searchQuery, selectedCategory, showSystemOnly, showTenantOnly]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [templatesResult, statsResult, categoriesResult] = await Promise.all([
        getAllPropertyTemplates(),
        getPropertyTemplateStats(),
        getPropertyTemplateCategoriesAdmin(),
      ]);

      const templatesData = JSON.parse(templatesResult);
      const statsData = JSON.parse(statsResult);
      const categoriesData = JSON.parse(categoriesResult);

      if (templatesData.success) {
        setTemplates(templatesData.templates);
      }
      if (statsData.success) {
        setStats(statsData.stats);
      }
      if (categoriesData.success) {
        setCategories(categoriesData.categories);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      showMessage('error', 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const filterTemplates = () => {
    let filtered = [...templates];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t =>
        t.name.toLowerCase().includes(query) ||
        (t.description && t.description.toLowerCase().includes(query)) ||
        t.tags.some(tag => tag.toLowerCase().includes(query))
      );
    }

    if (selectedCategory) {
      filtered = filtered.filter(t => t.category === selectedCategory);
    }

    if (showSystemOnly) {
      filtered = filtered.filter(t => t.is_system);
    }

    if (showTenantOnly) {
      filtered = filtered.filter(t => !t.is_system);
    }

    setFilteredTemplates(filtered);
  };

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      category: 'identifiers',
      customCategory: '',
      schema: JSON.stringify(defaultSchema, null, 2),
      tags: '',
      isSystem: true,
      isPublic: true,
    });
    setUseCustomCategory(false);
  };

  const handleCreate = async () => {
    try {
      let schema;
      try {
        schema = JSON.parse(formData.schema);
      } catch (e) {
        showMessage('error', 'Invalid JSON schema');
        return;
      }

      const tags = formData.tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      // Use custom category if enabled, otherwise use selected category
      const categoryToUse = useCustomCategory
        ? formData.customCategory.trim().toLowerCase().replace(/\s+/g, '-')
        : formData.category;

      if (!categoryToUse) {
        showMessage('error', 'Category is required');
        return;
      }

      const result = JSON.parse(await createPropertyTemplateAdmin(
        formData.name,
        formData.description || null,
        categoryToUse,
        schema,
        tags,
        formData.isSystem,
        formData.isPublic
      ));

      if (result.success) {
        showMessage('success', 'Template created successfully');
        setShowCreateDialog(false);
        resetForm();
        loadData();
      } else {
        showMessage('error', result.error || 'Failed to create template');
      }
    } catch (error: any) {
      showMessage('error', error.message || 'Failed to create template');
    }
  };

  const handleEdit = async () => {
    if (!selectedTemplate) return;

    try {
      let schema;
      try {
        schema = JSON.parse(formData.schema);
      } catch (e) {
        showMessage('error', 'Invalid JSON schema');
        return;
      }

      const tags = formData.tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      // Use custom category if enabled, otherwise use selected category
      const categoryToUse = useCustomCategory
        ? formData.customCategory.trim().toLowerCase().replace(/\s+/g, '-')
        : formData.category;

      if (!categoryToUse) {
        showMessage('error', 'Category is required');
        return;
      }

      const result = JSON.parse(await updatePropertyTemplateAdmin(
        selectedTemplate.id,
        formData.name,
        formData.description || null,
        categoryToUse,
        schema,
        tags,
        formData.isSystem,
        formData.isPublic,
        selectedTemplate.enabled
      ));

      if (result.success) {
        showMessage('success', 'Template updated successfully');
        setShowEditDialog(false);
        setSelectedTemplate(null);
        resetForm();
        loadData();
      } else {
        showMessage('error', result.error || 'Failed to update template');
      }
    } catch (error: any) {
      showMessage('error', error.message || 'Failed to update template');
    }
  };

  const handleDelete = async (template: PropertyTemplate) => {
    const confirmed = await confirm(
      destructiveConfirm({
        action: 'Delete',
        noun: 'template',
        name: template.name,
        consequence:
          'The template stops being offered when authors add a property. Properties already created from it are not changed.',
      })
    );
    if (!confirmed) return;

    try {
      const result = JSON.parse(await deletePropertyTemplateAdmin(template.id));

      if (result.success) {
        showMessage('success', 'Template deleted successfully');
        loadData();
      } else {
        showMessage('error', result.error || 'Failed to delete template');
      }
    } catch (error: any) {
      showMessage('error', error.message || 'Failed to delete template');
    }
  };

  const handleToggleStatus = async (template: PropertyTemplate) => {
    try {
      const result = JSON.parse(await togglePropertyTemplateStatus(template.id, !template.enabled));

      if (result.success) {
        showMessage('success', `Template ${template.enabled ? 'disabled' : 'enabled'} successfully`);
        loadData();
      } else {
        showMessage('error', result.error || 'Failed to toggle template status');
      }
    } catch (error: any) {
      showMessage('error', error.message || 'Failed to toggle template status');
    }
  };

  const openEditDialog = (template: PropertyTemplate) => {
    setSelectedTemplate(template);
    // Check if the category is a known category or custom
    const isKnownCategory = Object.keys(categoryConfig).includes(template.category);
    setUseCustomCategory(!isKnownCategory);
    setFormData({
      name: template.name,
      description: template.description || '',
      category: isKnownCategory ? template.category : 'identifiers',
      customCategory: isKnownCategory ? '' : template.category,
      schema: JSON.stringify(template.schema, null, 2),
      tags: template.tags.join(', '),
      isSystem: template.is_system,
      isPublic: template.is_public,
    });
    setShowEditDialog(true);
  };

  const openViewDialog = (template: PropertyTemplate) => {
    setSelectedTemplate(template);
    setShowViewDialog(true);
  };

  const copySchemaToClipboard = (schema: any) => {
    navigator.clipboard.writeText(JSON.stringify(schema, null, 2));
    showMessage('success', 'Schema copied to clipboard');
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950 dark:text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-lg">
            <Package className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Property Templates</h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Manage system and tenant property templates</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-600 text-gray-700 dark:text-white rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => {
              resetForm();
              setShowCreateDialog(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Template
          </button>
        </div>
      </div>

      {/* Message */}
      {message && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-lg border p-4 ${
            message.type === 'success'
              ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200'
              : 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200'
          }`}
        >
          {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          {message.text}
        </div>
      )}

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total_templates}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">Total Templates</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-amber-400">{stats.system_templates}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">System</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-blue-400">{stats.tenant_templates}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">Tenant</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-green-400">{stats.enabled_templates}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">Enabled</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-red-400">{stats.disabled_templates}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">Disabled</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-purple-400">{stats.total_usage}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">Total Usage</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-2xl font-bold text-cyan-400">{stats.category_count}</div>
            <div className="text-gray-500 dark:text-gray-400 text-sm">Categories</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap gap-4">
          {/* Search */}
          <div className="flex-1 min-w-64">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, description, or tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Category Filter */}
          <select
            value={selectedCategory || ''}
            onChange={(e) => setSelectedCategory(e.target.value || null)}
            className="px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All Categories</option>
            {categories.map(cat => (
              <option key={cat.category} value={cat.category}>
                {getCategoryConfig(cat.category).label} ({cat.count})
              </option>
            ))}
          </select>

          {/* Toggle Filters */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showSystemOnly}
                onChange={(e) => {
                  setShowSystemOnly(e.target.checked);
                  if (e.target.checked) setShowTenantOnly(false);
                }}
                className="w-4 h-4 rounded bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-gray-700 dark:text-gray-300 text-sm">System Only</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showTenantOnly}
                onChange={(e) => {
                  setShowTenantOnly(e.target.checked);
                  if (e.target.checked) setShowSystemOnly(false);
                }}
                className="w-4 h-4 rounded bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-gray-700 dark:text-gray-300 text-sm">Tenant Only</span>
            </label>
          </div>
        </div>
      </div>

      {/* Templates Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {/* The placeholder rows are decoration (`aria-hidden`), so this is the only thing a
            screen reader is told about the wait. */}
        <p role="status" aria-live="polite" className="sr-only">
          {loading ? 'Loading templates…' : ''}
        </p>
        <table className="w-full" aria-busy={loading || undefined}>
          <thead className="bg-slate-50 dark:bg-slate-800">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-300">Template</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-300">Category</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-300">Type</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-300">Schema Type</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-300">Usage</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-300">Status</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-300">Actions</th>
            </tr>
          </thead>
          {/* DESIGN.md §8: never a spinner in a table body. A `colSpan` row collapses the
              column widths, so every column jumps sideways the moment the rows land; the
              placeholder cells keep the grid and the wait is announced by the region. */}
          {loading ? (
            <SkeletonTableRows
              columns={TEMPLATE_SKELETON_COLUMNS}
              cellClassName="px-4 py-3"
              className="divide-y divide-slate-200 dark:divide-slate-800"
            />
          ) : null}
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {loading ? null : filteredTemplates.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No templates found
                </td>
              </tr>
            ) : (
              filteredTemplates.map((template) => {
                const catConfig = getCategoryConfig(template.category);
                return (
                  <tr key={template.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-white">{template.name}</span>
                        {template.is_system && (
                          <span title="System Template">
                            <Star className="w-4 h-4 text-amber-400" />
                          </span>
                        )}
                      </div>
                      {template.description && (
                        <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{template.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${catConfig.color}`}>
                        {catConfig.icon} {catConfig.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${
                        template.is_system ? 'bg-amber-900/50 text-amber-300' : 'bg-blue-900/50 text-blue-300'
                      }`}>
                        {template.is_system ? 'System' : 'Tenant'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-sm text-gray-600 dark:text-gray-300 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
                        {template.schema?.type || 'object'}
                        {template.schema?.format && ` (${template.schema.format})`}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-gray-600 dark:text-gray-300">{template.usage_count}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${
                        template.enabled ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
                      }`}>
                        {template.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="relative flex justify-end">
                        <button
                          onClick={() => setOpenDropdownId(openDropdownId === template.id ? null : template.id)}
                          className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                        >
                          <MoreVertical className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                        </button>

                        {openDropdownId === template.id && (
                          <>
                            {/* Backdrop to close dropdown when clicking outside */}
                            <div
                              className="fixed inset-0 z-10"
                              onClick={() => setOpenDropdownId(null)}
                            />

                            {/* Dropdown menu */}
                            <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 py-1">
                              <button
                                onClick={() => {
                                  openViewDialog(template);
                                  setOpenDropdownId(null);
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-600 hover:text-gray-900 dark:hover:text-white transition-colors"
                              >
                                <Eye className="w-4 h-4 text-gray-400" />
                                View Details
                              </button>
                              <button
                                onClick={() => {
                                  openEditDialog(template);
                                  setOpenDropdownId(null);
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-600 hover:text-gray-900 dark:hover:text-white transition-colors"
                              >
                                <Edit className="w-4 h-4 text-blue-400" />
                                Edit Template
                              </button>
                              <button
                                onClick={() => {
                                  copySchemaToClipboard(template.schema);
                                  setOpenDropdownId(null);
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-600 hover:text-gray-900 dark:hover:text-white transition-colors"
                              >
                                <Copy className="w-4 h-4 text-gray-400" />
                                Copy Schema
                              </button>
                              <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
                              <button
                                onClick={() => {
                                  handleToggleStatus(template);
                                  setOpenDropdownId(null);
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-600 hover:text-gray-900 dark:hover:text-white transition-colors"
                              >
                                <Power className={`w-4 h-4 ${template.enabled ? 'text-green-400' : 'text-red-400'}`} />
                                {template.enabled ? 'Disable Template' : 'Enable Template'}
                              </button>
                              <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
                              <button
                                onClick={() => {
                                  handleDelete(template);
                                  setOpenDropdownId(null);
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete Template
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Create/Edit Dialog */}
      {(showCreateDialog || showEditDialog) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-900 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {showCreateDialog ? 'Create New Template' : 'Edit Template'}
              </h2>
              <button
                onClick={() => {
                  setShowCreateDialog(false);
                  setShowEditDialog(false);
                  setSelectedTemplate(null);
                  resetForm();
                }}
                className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., UUID, Email, Created At"
                  className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Brief description of the template"
                  className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category *</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useCustomCategory}
                      onChange={(e) => setUseCustomCategory(e.target.checked)}
                      className="w-4 h-4 rounded bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-gray-500 dark:text-gray-400 text-sm">Create new category</span>
                  </label>

                  {useCustomCategory ? (
                    <input
                      type="text"
                      value={formData.customCategory}
                      onChange={(e) => setFormData({ ...formData, customCategory: e.target.value })}
                      placeholder="Enter new category name (e.g., medical, legal, custom-fields)"
                      className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  ) : (
                    <select
                      value={formData.category}
                      onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                      className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {Object.entries(categoryConfig).map(([key, config]) => (
                        <option key={key} value={key}>
                          {config.icon} {config.label}
                        </option>
                      ))}
                    </select>
                  )}

                  {useCustomCategory && (
                    <p className="text-xs text-gray-500">
                      Category will be converted to lowercase with hyphens (e.g., &quot;Medical Records&quot; → &quot;medical-records&quot;)
                    </p>
                  )}
                </div>
              </div>

              {/* Schema */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">JSON Schema *</label>
                <textarea
                  value={formData.schema}
                  onChange={(e) => setFormData({ ...formData, schema: e.target.value })}
                  rows={10}
                  placeholder='{"type": "string", "format": "uuid", "description": "...", "example": "..."}'
                  className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm"
                />
              </div>

              {/* Tags */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  placeholder="id, uuid, identifier, primary-key"
                  className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Checkboxes */}
              <div className="flex gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isSystem}
                    onChange={(e) => setFormData({ ...formData, isSystem: e.target.checked })}
                    className="w-4 h-4 rounded bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-gray-700 dark:text-gray-300">System Template</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isPublic}
                    onChange={(e) => setFormData({ ...formData, isPublic: e.target.checked })}
                    className="w-4 h-4 rounded bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-gray-700 dark:text-gray-300">Public</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800">
              <button
                onClick={() => {
                  setShowCreateDialog(false);
                  setShowEditDialog(false);
                  setSelectedTemplate(null);
                  resetForm();
                }}
                className="px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-600 text-gray-700 dark:text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={showCreateDialog ? handleCreate : handleEdit}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
              >
                {showCreateDialog ? 'Create Template' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Dialog */}
      {showViewDialog && selectedTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-900 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{selectedTemplate.name}</h2>
                {selectedTemplate.is_system && (
                  <Star className="w-5 h-5 text-amber-400" />
                )}
              </div>
              <button
                onClick={() => {
                  setShowViewDialog(false);
                  setSelectedTemplate(null);
                }}
                className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Description */}
              {selectedTemplate.description && (
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Description</label>
                  <p className="text-gray-900 dark:text-white">{selectedTemplate.description}</p>
                </div>
              )}

              {/* Category & Type */}
              <div className="flex gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Category</label>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm ${getCategoryConfig(selectedTemplate.category).color}`}>
                    {getCategoryConfig(selectedTemplate.category).icon} {getCategoryConfig(selectedTemplate.category).label}
                  </span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Type</label>
                  <span className={`px-2 py-1 rounded text-sm ${
                    selectedTemplate.is_system ? 'bg-amber-900/50 text-amber-300' : 'bg-blue-900/50 text-blue-300'
                  }`}>
                    {selectedTemplate.is_system ? 'System' : 'Tenant'}
                  </span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Status</label>
                  <span className={`px-2 py-1 rounded text-sm ${
                    selectedTemplate.enabled ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
                  }`}>
                    {selectedTemplate.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>

              {/* Usage & Visibility */}
              <div className="flex gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Usage Count</label>
                  <span className="text-gray-900 dark:text-white">{selectedTemplate.usage_count}</span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Visibility</label>
                  <span className="text-gray-900 dark:text-white">{selectedTemplate.is_public ? 'Public' : 'Private'}</span>
                </div>
              </div>

              {/* Tags */}
              {selectedTemplate.tags && selectedTemplate.tags.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Tags</label>
                  <div className="flex flex-wrap gap-1">
                    {selectedTemplate.tags.map((tag, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-gray-300 rounded text-sm">
                        <Tag className="w-3 h-3" />
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Schema */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">JSON Schema</label>
                  <button
                    onClick={() => copySchemaToClipboard(selectedTemplate.schema)}
                    className="flex items-center gap-1 text-sm text-indigo-400 hover:text-indigo-300"
                  >
                    <Copy className="w-4 h-4" />
                    Copy
                  </button>
                </div>
                <pre className="bg-slate-100 dark:bg-slate-950 rounded-lg p-4 overflow-auto max-h-60 text-sm text-gray-700 dark:text-gray-300 font-mono">
                  {JSON.stringify(selectedTemplate.schema, null, 2)}
                </pre>
              </div>

              {/* Metadata */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <label className="block text-gray-500 dark:text-gray-400">Created</label>
                  <span className="text-gray-900 dark:text-white">{new Date(selectedTemplate.created_at).toLocaleString()}</span>
                </div>
                <div>
                  <label className="block text-gray-500 dark:text-gray-400">Updated</label>
                  <span className="text-gray-900 dark:text-white">{new Date(selectedTemplate.updated_at).toLocaleString()}</span>
                </div>
                {selectedTemplate.tenant_name && (
                  <div>
                    <label className="block text-gray-500 dark:text-gray-400">Tenant</label>
                    <span className="text-gray-900 dark:text-white">{selectedTemplate.tenant_name}</span>
                  </div>
                )}
                {selectedTemplate.creator_name && (
                  <div>
                    <label className="block text-gray-500 dark:text-gray-400">Created By</label>
                    <span className="text-gray-900 dark:text-white">{selectedTemplate.creator_name}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800">
              <button
                onClick={() => {
                  setShowViewDialog(false);
                  openEditDialog(selectedTemplate);
                }}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
              >
                Edit Template
              </button>
              <button
                onClick={() => {
                  setShowViewDialog(false);
                  setSelectedTemplate(null);
                }}
                className="px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-600 text-gray-700 dark:text-white rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

