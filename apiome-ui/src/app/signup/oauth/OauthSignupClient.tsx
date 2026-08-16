"use client";

import { useState } from "react";
import { signIn } from '@lib/auth/session-client';
import { User, Building2, Link2 } from "lucide-react";
import { completeOAuthSignup } from "../../../../lib/auth/oauth-signup-actions";
import { ICON_SIZE } from '@/app/components/ui/iconSizes';

function generateSlug(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type Props = {
  token: string;
  emailHint: string;
};

export default function OauthSignupClient({ token, emailHint }: Props) {
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOrgChange = (v: string) => {
    setOrgName(v);
    if (!slugTouched) {
      setSlug(generateSlug(v));
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await completeOAuthSignup(token, displayName, orgName, slug);
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      await signIn("credentials", {
        payload: JSON.stringify({ oneTimeCode: result.oneTimeCode }),
        callbackUrl: "/ade",
        redirect: true,
      });
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50/30 to-purple-50/30 dark:from-slate-950 dark:via-slate-900 dark:to-indigo-950/40 flex items-center justify-center p-4">
      <div className="w-full max-w-md relative z-10">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl shadow-2xl shadow-indigo-500/10 p-8 border border-white/50 dark:bg-slate-900/80 dark:border-slate-700/60 dark:shadow-black/30">
          <div className="flex justify-center mb-6">
            <div className="rounded-full bg-indigo-100 dark:bg-indigo-900/40 p-3">
              <Link2 className="w-8 h-8 text-indigo-600 dark:text-indigo-300" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-gray-900 dark:text-slate-100 mb-1">
            Finish setting up your account
          </h1>
          <p className="text-sm text-center text-gray-500 dark:text-slate-400 mb-6">
            Signed in as <span className="font-medium text-gray-700 dark:text-slate-300">{emailHint}</span>
          </p>
          <div className="mb-6 p-4 rounded-xl bg-emerald-50/90 border border-emerald-200 text-emerald-900 text-sm dark:bg-emerald-900/25 dark:border-emerald-800 dark:text-emerald-100">
            <p className="font-semibold mb-1">Free plan</p>
            <p>Includes 1 organization, 1 project, and up to 3 versions. You can upgrade anytime.</p>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm dark:bg-red-900/30 dark:border-red-800 dark:text-red-200">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-5">
            <div>
              <label htmlFor="displayName" className="block text-sm font-semibold text-gray-700 mb-1.5 dark:text-slate-300">
                Your name
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User size={ICON_SIZE.dense} className="text-gray-400 dark:text-slate-500" />
                </div>
                <input
                  id="displayName"
                  name="displayName"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="block w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-gray-800 bg-white dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  placeholder="Jane Doe"
                  disabled={busy}
                />
              </div>
            </div>

            <div>
              <label htmlFor="orgName" className="block text-sm font-semibold text-gray-700 mb-1.5 dark:text-slate-300">
                Organization name
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Building2 size={ICON_SIZE.dense} className="text-gray-400 dark:text-slate-500" />
                </div>
                <input
                  id="orgName"
                  name="orgName"
                  required
                  value={orgName}
                  onChange={(e) => onOrgChange(e.target.value)}
                  className="block w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-gray-800 bg-white dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  placeholder="Acme Design"
                  disabled={busy}
                />
              </div>
            </div>

            <div>
              <label htmlFor="slug" className="block text-sm font-semibold text-gray-700 mb-1.5 dark:text-slate-300">
                Organization URL slug
              </label>
              <input
                id="slug"
                name="slug"
                required
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                className="block w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-gray-800 bg-white dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                placeholder="acme-design"
                disabled={busy}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-slate-500">
                Lowercase letters, numbers, and dashes only. Used in API paths for your organization.
              </p>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white py-3.5 rounded-xl font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Creating your workspace…" : "Create account"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6 dark:text-slate-500">
          <a href="/login" className="text-indigo-500 hover:underline dark:text-indigo-300">
            Back to sign in
          </a>
        </p>
      </div>
    </div>
  );
}
