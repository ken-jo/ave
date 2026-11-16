import { screen } from "@testing-library/react";
import { TEST_IDS } from "../../../../../shared/test-ids.js";

/** The composer's text box in the rendered tree. */
export const composerTextarea = (): HTMLTextAreaElement => screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
