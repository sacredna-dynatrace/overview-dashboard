import { SegmentsProvider } from "@dynatrace/strato-components/filters";
import { PageLayout } from "@dynatrace/strato-components/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { SegmentQueryScope } from "./components/SegmentQueryScope";
import { TagFilterProvider } from "./components/SharedFilters";
import { BlastRadius } from "./pages/BlastRadius";
import { Home } from "./pages/Home";
import { Starfield } from "./pages/Starfield";

export const App = () => {
  return (
    <PageLayout>
      <PageLayout.Header>
        <Header />
      </PageLayout.Header>
      <PageLayout.Content>
        {/* Segments and tags are chosen once and hold on every page. Queries that must not be
            narrowed - entity lists, Blast radius's dependency graph - opt out with filterSegments: []. */}
        <SegmentsProvider>
          <SegmentQueryScope>
            <TagFilterProvider>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/blast-radius" element={<BlastRadius />} />
                <Route path="/starfield" element={<Starfield />} />
              </Routes>
            </TagFilterProvider>
          </SegmentQueryScope>
        </SegmentsProvider>
      </PageLayout.Content>
    </PageLayout>
  );
};
