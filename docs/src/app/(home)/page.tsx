import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-3 text-3xl font-bold">hymem</h1>
      <p className="mb-8 max-w-xl text-fd-muted-foreground">
        Temporal, multi-tenant memory for AI agents — with pluggable storage.
        Facts with lifetimes, honest abstention, and one adapter contract across
        seven databases.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          Read the docs
        </Link>
        <a
          href="https://github.com/codewithveek/hymem"
          className="rounded-lg border px-4 py-2 text-sm font-medium"
        >
          GitHub
        </a>
        <a href="/llms.txt" className="rounded-lg border px-4 py-2 text-sm font-medium">
          llms.txt
        </a>
      </div>
      <p className="mt-8 text-xs text-fd-muted-foreground">
        Every page is available as raw markdown — append <code>.md</code> to any docs URL.
      </p>
    </main>
  );
}
