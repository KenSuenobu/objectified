/**
 * The re-tokened `components/ui` primitives (HIVE-2.1, #5280).
 *
 * The ticket's promise is narrow and testable: the primitives now paint from the Hive token
 * layer instead of from the Tailwind palette, they gained the DESIGN.md §7 vocabulary, and
 * **no consumer needed an edit**. Those are the three things this suite holds down:
 *
 *   1. the new variant/size/shape vocabulary renders the tokens the design authority names;
 *   2. every pre-Hive prop value — `variant="outline"`, `variant="error"`, `size="icon"` —
 *      still resolves, because 300-odd call sites pass them;
 *   3. the behaviour each primitive is relied on for (asChild, indeterminate, invalid
 *      fields, `data-status`) is unchanged or strictly better.
 *
 * The stylesheet's half of the bargain — the control chrome, the focus ring, the absence of
 * palette classes — is `tests/hive-primitive-tokens.test.ts`.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  FormField,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
  Textarea,
  badgeToneForStatus,
  buttonVariants,
  tabListClass,
  tabTriggerClass,
  tabTriggerRadixClass,
} from '../src/app/components/ui';

/** Every class on an element, as a set — order is meaningless, membership is not. */
function classesOf(element: Element): Set<string> {
  return new Set(element.className.split(/\s+/).filter(Boolean));
}

describe('Button — DESIGN.md §7 vocabulary', () => {
  it('paints the primary action in ink, not in a palette colour', () => {
    render(<Button variant="primary">New project</Button>);
    const classes = classesOf(screen.getByRole('button'));
    expect(classes).toContain('bg-ink');
    expect(classes).toContain('text-ink-fg');
    // `-slate-` rather than `slate`: `translate-y-px` is a geometry utility, not a palette one.
    expect([...classes].some((c) => /-(?:indigo|slate|gray|emerald|red|amber)-/.test(c))).toBe(false);
  });

  it.each([
    ['accent', 'bg-accent'],
    ['soft', 'bg-subtle'],
    ['ghost', 'bg-transparent'],
    ['danger', 'bg-danger'],
    ['danger-soft', 'bg-danger-soft'],
    ['honey', 'bg-honey'],
    ['outline', 'bg-surface'],
  ] as const)('renders the %s variant from its role token', (variant, expected) => {
    render(<Button variant={variant}>Act</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain(expected);
  });

  it('keeps every pre-Hive variant name working, mapped onto a Hive role', () => {
    // The five aliases below are what ~300 call sites pass today; each must still resolve,
    // and must resolve to the *same* classes as the Hive name it now means.
    expect(buttonVariants({ variant: 'default' })).toBe(buttonVariants({ variant: 'primary' }));
    expect(buttonVariants({ variant: 'secondary' })).toBe(buttonVariants({ variant: 'soft' }));
    expect(buttonVariants({ variant: 'destructive' })).toBe(buttonVariants({ variant: 'danger' }));
    expect(buttonVariants({ variant: 'outline' })).toContain('bg-surface');
    expect(buttonVariants({ variant: 'success' })).toContain('bg-ok');
  });

  it('takes its height from the density-aware control metric, never a frozen one', () => {
    const { rerender } = render(<Button size="default">A</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain('h-[var(--control-h)]');

    rerender(<Button size="sm">A</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain('h-[var(--control-h-sm)]');

    rerender(<Button size="lg">A</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain('h-[var(--control-h-lg)]');

    rerender(<Button size="icon">A</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain('size-[var(--control-h)]');
  });

  it('lets a caller override the height, which is what keeps this a restyle', () => {
    // `cn()` is tailwind-merge: the arbitrary metric and a caller's own `h-8` are the same
    // group, so only the caller's survives. A named utility (`h-control`) would not merge.
    render(<Button className="h-8">A</Button>);
    const classes = classesOf(screen.getByRole('button'));
    expect(classes).toContain('h-8');
    expect(classes).not.toContain('h-[var(--control-h)]');
  });

  it('rounds fully when asked for a pill', () => {
    render(<Button pill>Filter</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain('rounded-full');
  });

  it('renders a trailing shortcut chip that assistive technology ignores', () => {
    render(<Button kbd="N">New project</Button>);
    const chip = screen.getByRole('button').querySelector('.kbd');
    expect(chip).toHaveTextContent('N');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
  });

  it('still renders a link as the button itself, shortcut included', () => {
    render(
      <Button asChild kbd="G">
        <a href="/ade">Go</a>
      </Button>
    );
    const link = screen.getByRole('link', { name: 'Go' });
    expect(classesOf(link)).toContain('bg-ink');
    expect(link.querySelector('.kbd')).toHaveTextContent('G');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gives the link variant no box to sit in', () => {
    render(<Button variant="link">Read more</Button>);
    const classes = classesOf(screen.getByRole('button'));
    expect(classes).toContain('h-auto');
    expect(classes).toContain('text-accent');
  });
});

describe('Badge — the status vocabulary', () => {
  it.each([
    ['published', 'bg-ok-soft'],
    ['draft', 'bg-neutral-soft'],
    ['degraded', 'bg-warn-soft'],
    ['failed', 'bg-danger-soft'],
    ['deprecated', 'bg-orange-soft'],
    ['preview', 'bg-accent-soft'],
    ['private', 'bg-violet-soft'],
    ['new', 'bg-honey-soft'],
  ])('gives %s its DESIGN.md §7 tone', (status, expected) => {
    render(<Badge status={status}>{status}</Badge>);
    expect(classesOf(screen.getByText(status))).toContain(expected);
  });

  it('writes the status to the DOM so a page can still query or style off it', () => {
    render(<Badge status="Published">Published</Badge>);
    expect(screen.getByText('Published')).toHaveAttribute('data-status', 'Published');
  });

  it('reads a raw data-status attribute the same way as the typed prop', () => {
    render(<Badge data-status="failed">Failed</Badge>);
    expect(classesOf(screen.getByText('Failed'))).toContain('bg-danger-soft');
  });

  it('falls back to neutral for a state the design language has not been told about', () => {
    expect(badgeToneForStatus('quiescent')).toBe('neutral');
    expect(badgeToneForStatus('  PUBLISHED ')).toBe('ok');
  });

  it('lets the status win over an explicitly named tone', () => {
    render(
      <Badge variant="danger" status="published">
        Published
      </Badge>
    );
    expect(classesOf(screen.getByText('Published'))).toContain('bg-ok-soft');
  });

  it('draws a leading dot in its own ink when asked', () => {
    render(<Badge status="published" dot>Published</Badge>);
    const dot = screen.getByTestId('badge-dot');
    expect(classesOf(dot)).toContain('bg-current');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the pre-Hive tone names working', () => {
    render(
      <>
        <Badge variant="error">e</Badge>
        <Badge variant="warning">w</Badge>
        <Badge variant="success">s</Badge>
        <Badge variant="secondary">n</Badge>
      </>
    );
    expect(classesOf(screen.getByText('e'))).toContain('bg-danger-soft');
    expect(classesOf(screen.getByText('w'))).toContain('bg-warn-soft');
    expect(classesOf(screen.getByText('s'))).toContain('bg-ok-soft');
    expect(classesOf(screen.getByText('n'))).toContain('bg-neutral-soft');
  });

  it('renders an identifier in the mono face, which the preference can swap', () => {
    render(<Badge mono>ver_2f81</Badge>);
    expect(classesOf(screen.getByText('ver_2f81'))).toContain('mono');
  });
});

describe('Form controls', () => {
  it('gives every text control the same chrome class, so one rule styles them all', () => {
    render(
      <>
        <Input aria-label="name" />
        <Textarea aria-label="description" />
      </>
    );
    expect(classesOf(screen.getByLabelText('name'))).toContain('hive-control');
    expect(classesOf(screen.getByLabelText('description'))).toContain('hive-control');
  });

  it('sizes the input from the control metric', () => {
    render(<Input aria-label="name" />);
    expect(classesOf(screen.getByLabelText('name'))).toContain('h-[var(--control-h)]');
  });

  it('marks the control invalid — not the wrapper — when the field has an error', () => {
    render(
      <FormField label="Email" error="Enter a valid email address.">
        <Input aria-label="email" />
      </FormField>
    );
    expect(screen.getByLabelText('email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('leaves a control that already states its own validity alone', () => {
    render(
      <FormField label="Email" error="Nope.">
        <Input aria-label="email" aria-invalid={false} />
      </FormField>
    );
    expect(screen.getByLabelText('email')).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows the hint only while there is no error to show instead', () => {
    const { rerender } = render(
      <FormField label="Slug" helperText="Lowercase letters, numbers and dashes.">
        <Input aria-label="slug" />
      </FormField>
    );
    expect(screen.getByText('Lowercase letters, numbers and dashes.')).toBeInTheDocument();

    rerender(
      <FormField label="Slug" helperText="Lowercase letters, numbers and dashes." error="Taken.">
        <Input aria-label="slug" />
      </FormField>
    );
    expect(screen.queryByText('Lowercase letters, numbers and dashes.')).toBeNull();
    expect(screen.getByText('Taken.')).toBeInTheDocument();
  });

  it('inks the label rather than muting it', () => {
    render(<Label>Project name</Label>);
    expect(classesOf(screen.getByText('Project name'))).toContain('text-fg');
  });

  it('parks a mixed switch between its two ends and says so', () => {
    render(<Switch indeterminate aria-label="all rows" />);
    const input = screen.getByLabelText('all rows');
    expect(input).toHaveAttribute('aria-checked', 'mixed');
    // The thumb sits at half travel — "some" must not look like "all".
    const thumb = input.parentElement?.querySelectorAll('span')[1];
    expect(classesOf(thumb as Element)).toContain('translate-x-[0.4375rem]');
  });

  it('drives the switch through onCheckedChange, unchanged', () => {
    const onCheckedChange = jest.fn();
    render(<Switch aria-label="anon" onCheckedChange={onCheckedChange} />);
    screen.getByLabelText('anon').click();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('fills the checkbox with accent when ticked', () => {
    render(<Checkbox checked aria-label="select row" />);
    expect(classesOf(screen.getByRole('checkbox'))).toContain('data-[state=checked]:bg-accent');
  });

  it('tints a native radio with the theme accent', () => {
    render(
      <RadioGroup value="rest">
        <RadioGroupItem value="rest" label="REST" />
        <RadioGroupItem value="graphql" label="GraphQL" />
      </RadioGroup>
    );
    const radios = screen.getAllByRole('radio');
    expect(classesOf(radios[0])).toContain('accent-accent');
    expect(radios[0]).toBeChecked();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });
});

describe('Card', () => {
  it('is a surface with elevation rather than a bordered box', () => {
    const { container } = render(<Card>body</Card>);
    const classes = classesOf(container.firstElementChild as Element);
    expect(classes).toContain('bg-surface');
    expect(classes).toContain('shadow-sm');
    expect([...classes].some((c) => c.startsWith('border-'))).toBe(false);
  });

  it('swaps elevation for a hairline when flat', () => {
    const { container } = render(<Card variant="flat">body</Card>);
    expect(classesOf(container.firstElementChild as Element)).toContain(
      'shadow-[inset_0_0_0_1px_var(--border)]'
    );
  });

  it('separates its header and footer with the token hairline', () => {
    render(
      <Card>
        <CardHeader>head</CardHeader>
        <CardFooter>foot</CardFooter>
      </Card>
    );
    expect(classesOf(screen.getByText('head'))).toContain('border-border');
    expect(classesOf(screen.getByText('foot'))).toContain('border-border');
  });

  it('lets a caller override the density-aware padding', () => {
    render(<CardHeader className="p-4">head</CardHeader>);
    const classes = classesOf(screen.getByText('head'));
    expect(classes).toContain('p-4');
    expect(classes).not.toContain('p-[var(--card-pad)]');
  });
});

describe('Alert — the banner', () => {
  it.each([
    ['info', 'bg-accent-soft'],
    ['ok', 'bg-ok-soft'],
    ['warn', 'bg-warn-soft'],
    ['danger', 'bg-danger-soft'],
    ['honey', 'bg-honey-soft'],
    ['neutral', 'bg-subtle'],
  ] as const)('tints the %s tone from its token', (variant, expected) => {
    render(<Alert variant={variant}>message</Alert>);
    expect(classesOf(screen.getByRole('alert'))).toContain(expected);
  });

  it('keeps the pre-Hive tone names working', () => {
    const { rerender } = render(<Alert variant="error">boom</Alert>);
    expect(classesOf(screen.getByRole('alert'))).toContain('bg-danger-soft');
    rerender(<Alert variant="success">done</Alert>);
    expect(classesOf(screen.getByRole('alert'))).toContain('bg-ok-soft');
  });

  it('renders title, body and an actions row', () => {
    render(
      <Alert variant="danger" actions={<Button size="sm">Retry</Button>}>
        <AlertTitle>Import failed</AlertTitle>
        <AlertDescription>The file could not be parsed.</AlertDescription>
      </Alert>
    );
    expect(screen.getByText('Import failed')).toBeInTheDocument();
    expect(screen.getByText('The file could not be parsed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('still offers a dismiss button when given onClose', () => {
    const onClose = jest.fn();
    render(<Alert onClose={onClose}>message</Alert>);
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalled();
  });

  it('can be handed its own leading glyph, or none at all', () => {
    const { container, rerender } = render(<Alert icon={null}>message</Alert>);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
    rerender(<Alert icon={<span data-testid="custom" />}>message</Alert>);
    expect(screen.getByTestId('custom')).toBeInTheDocument();
  });
});

describe('Dialog', () => {
  it.each([
    ['sm', 'max-w-[27.5rem]'],
    ['default', 'max-w-[35rem]'],
    ['lg', 'max-w-[47.5rem]'],
    ['xl', 'max-w-[60rem]'],
    ['full', 'max-w-[75rem]'],
  ] as const)('renders the %s width from the DESIGN.md §7 vocabulary', (size, expected) => {
    render(
      <Dialog open>
        <DialogContent size={size}>
          <DialogTitle>Publish</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(classesOf(screen.getByRole('dialog'))).toContain(expected);
  });

  it('rounds to the 20 px dialog radius on the surface colour', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Publish</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    const classes = classesOf(screen.getByRole('dialog'));
    expect(classes).toContain('rounded-xl');
    expect(classes).toContain('bg-surface');
  });

  it('lets a caller keep its own width, which is what 30-odd dialogs already do', () => {
    render(
      <Dialog open>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Publish</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    const classes = classesOf(screen.getByRole('dialog'));
    expect(classes).toContain('max-w-2xl');
    expect(classes).not.toContain('max-w-[35rem]');
  });

  it('bleeds the footer to the dialog edges by default, and stops when told to', () => {
    const { rerender } = render(<DialogFooter>actions</DialogFooter>);
    expect(classesOf(screen.getByText('actions'))).toContain('-mx-6');
    rerender(<DialogFooter bleed={false}>actions</DialogFooter>);
    expect(classesOf(screen.getByText('actions'))).not.toContain('-mx-6');
  });
});

describe('Tabs', () => {
  it('inks the selected underline tab in --fg, not in a brand palette colour', () => {
    expect(tabTriggerClass({ active: true })).toContain('border-fg');
    expect(tabTriggerClass({ active: true })).toContain('text-fg');
    expect(tabTriggerRadixClass()).toContain('data-[state=active]:border-fg');
  });

  it('offers the pills and vertical shapes the mockups use', () => {
    expect(tabListClass('pills')).not.toContain('border-b');
    expect(tabTriggerClass({ active: true, variant: 'pills' })).toContain('bg-fg');
    expect(tabListClass('vertical')).toContain('flex-col');
    expect(tabTriggerClass({ active: true, variant: 'vertical' })).toContain('bg-subtle');
  });

  it('grows rather than clips a long label at the largest font scale', () => {
    // `min-h` rather than `h`: the 36 px tab is a floor, not a ceiling.
    expect(tabTriggerClass()).toContain('min-h-[var(--control-h)]');
    expect(tabTriggerClass({ size: 'sm' })).toContain('min-h-[var(--control-h-sm)]');
  });

  it('still selects panels the way every existing strip expects', () => {
    render(
      <Tabs defaultValue="versions">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="versions">
            Versions <TabsCount>6</TabsCount>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">overview pane</TabsContent>
        <TabsContent value="versions">versions pane</TabsContent>
      </Tabs>
    );
    expect(screen.getByText('versions pane')).toBeInTheDocument();
    expect(screen.queryByText('overview pane')).toBeNull();
    expect(classesOf(screen.getByText('6'))).toContain('bg-inset');
  });
});

describe('Loading primitives', () => {
  it('pulses the skeleton on the inset surface', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(classesOf(container.firstElementChild as Element)).toContain('bg-inset');
  });

  it('draws the spinner as a hairline ring with one accent quadrant', () => {
    render(<Spinner label="Loading versions" />);
    const classes = classesOf(screen.getByRole('status'));
    expect(classes).toContain('border-border-strong');
    expect(classes).toContain('border-t-accent');
  });
});
