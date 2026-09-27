/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The whole cockpit page over the in-browser mock backend (fictional recordings). */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ServicesProvider } from '../app/services';
import { createServices, type Services } from '../lib/config';
import type { Transport } from '../lib/transport';
import { createMockServices } from '../mocks/services';
import Cockpit from './Cockpit';

const meta: Meta = { title: 'Pages/Cockpit', parameters: { layout: 'fullscreen' } };
export default meta;
type Story = StoryObj<{ services: Services }>;

function Page({ services, path }: { services: Services; path: string }) {
  return (
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/runs/:runId" element={<Cockpit />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>
  );
}

const hanging: Transport = {
  fetch: (input) =>
    input.endsWith('/config') ? Promise.reject(new TypeError('offline')) : new Promise<Response>(() => {}),
  openSocket: () => ({ onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }),
};
const failing: Transport = {
  fetch: async () =>
    new Response(JSON.stringify({ error: 'Run not found', code: 'not_found' }), { status: 404 }),
  openSocket: () => ({ onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }),
};

export const Empty: Story = {
  name: 'Empty (run just created)',
  loaders: [async () => ({ services: await createMockServices() })],
  render: (_a, { loaded }) => <Page services={loaded.services as Services} path="/runs/run-demo-s01?at=0" />,
};
export const Loading: Story = {
  loaders: [
    async () => ({
      services: await createServices({
        runtime: { apiUrl: 'mock://api', wsUrl: 'mock://ws', auth: { mode: 'none' } },
        transport: hanging,
        mode: 'mock',
      }),
    }),
  ],
  render: (_a, { loaded }) => <Page services={loaded.services as Services} path="/runs/run-x" />,
};
export const Live: Story = {
  name: 'Live (options decision pending, minute 31)',
  loaders: [async () => ({ services: await createMockServices() })],
  render: (_a, { loaded }) => <Page services={loaded.services as Services} path="/runs/run-demo-s01?at=31" />,
};
export const ErrorState: Story = {
  name: 'Error (run not found)',
  loaders: [
    async () => ({
      services: await createServices({
        runtime: { apiUrl: 'mock://api', wsUrl: 'mock://ws', auth: { mode: 'none' } },
        transport: failing,
        mode: 'mock',
      }),
    }),
  ],
  render: (_a, { loaded }) => <Page services={loaded.services as Services} path="/runs/run-missing" />,
};
