import { MarkmapEditor, createEditView } from '@markmap/edit-dom';
import { parseDocument } from '@markmap/model';
import { Markmap } from '@markmap/view';

const SAMPLE = `# Trip

## Before

- Book flights
- Pack

## During

- See the sights
`;

const source = document.querySelector<HTMLTextAreaElement>('#source')!;
const stage = document.querySelector<HTMLDivElement>('#stage')!;
const status = document.querySelector<HTMLSpanElement>('#status')!;
source.value = localStorage.getItem('markmap:editor') ?? SAMPLE;

const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
stage.append(svg);

const parsed = parseDocument(source.value);
const mm = Markmap.create(svg, parsed.tree, { wrapWidth: 280, duration: 200 });
mm.fit();

const editor = new MarkmapEditor({
  source: source.value,
  view: createEditView(mm),
  container: stage,
  onChange: ({ source: next, selection }) => {
    source.value = next;
    source.setSelectionRange(selection, selection);
    localStorage.setItem('markmap:editor', next);
    status.textContent = '';
  },
  onError: (error) => {
    status.textContent = error.message;
    status.style.color = '#c0392b';
  },
});

let timer: ReturnType<typeof setTimeout> | undefined;
source.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    editor.setSource(source.value);
  }, 200);
});

document.querySelector('#edit')!.addEventListener('click', () => editor.startEditing());
document.querySelector('#fit')!.addEventListener('click', () => mm.fit());
document.querySelector('#undo')!.addEventListener('click', () => editor.undo());
document.querySelector('#redo')!.addEventListener('click', () => editor.redo());

Object.assign(window, { mm, editor });
