import React from 'react';
import { render } from '@testing-library/react';
import { act } from 'react-dom/test-utils';

import App from './App';

// https://stackoverflow.com/a/53449595/1804173
// import './mocks.mock';
window.matchMedia = window.matchMedia || function() {
  return {
    matches: false,
    addListener: function() {},
    removeListener: function() {}
  };
};


test('basic app rendering', async () => {
  await act(async () => {
    render(<App />);
  })
});
