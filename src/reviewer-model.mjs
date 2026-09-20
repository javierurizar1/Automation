const SELECTOR_BUTTON_NAME = 'Select ChatGPT model';
export const REQUIRED_REVIEWER_MODEL = 'GPT-5.6 Sol';
export const REQUIRED_REVIEWER_EFFORT = 'High';
const REQUIRED_POWER_VALUE = 2;
const REQUIRED_REVIEWER_EFFORT_STATUS = /^High,\s*3 of 3\.?$/;

function modelUnavailable(message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'REVIEWER_MODEL_UNAVAILABLE';
  return error;
}

async function findModelOption(menu) {
  const options = menu.locator('[role="menuitemradio"]');
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const label = (await option.innerText()).trim().split(/\r?\n/, 1)[0].trim();
    if (label === REQUIRED_REVIEWER_MODEL) return option;
  }
  return null;
}

/**
 * Enforce the highest model and reasoning effort currently exposed as selectable
 * in the signed-in ChatGPT session. Locked upgrade options are never opened.
 */
export async function ensureHighestReviewerModel(page) {
  let menuOpened = false;
  try {
    const selector = page.getByRole('button', { name: SELECTOR_BUTTON_NAME });
    await selector.waitFor({ state: 'visible', timeout: 15000 });
    if (await selector.count() !== 1) {
      throw modelUnavailable('ChatGPT model selector was not found exactly once');
    }
    await selector.click();
    menuOpened = true;

    let menu = page.getByRole('menu').last();
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    let modelOption = await findModelOption(menu);
    if (!modelOption) {
      throw modelUnavailable(`${REQUIRED_REVIEWER_MODEL} is not available in the model menu`);
    }
    if ((await modelOption.getAttribute('aria-disabled')) === 'true') {
      throw modelUnavailable(`${REQUIRED_REVIEWER_MODEL} is locked in the current account`);
    }
    if ((await modelOption.getAttribute('aria-checked')) !== 'true') {
      await modelOption.click();
      menu = page.getByRole('menu').last();
      if (!(await menu.isVisible().catch(() => false))) {
        await selector.click();
        menu = page.getByRole('menu').last();
        await menu.waitFor({ state: 'visible', timeout: 5000 });
      }
      modelOption = await findModelOption(menu);
      if (!modelOption || (await modelOption.getAttribute('aria-checked')) !== 'true') {
        throw modelUnavailable(`${REQUIRED_REVIEWER_MODEL} could not be selected and verified`);
      }
    }

    const power = menu.locator('[role="menuitem"][aria-label="Power"]');
    const slider = menu.locator('[role="slider"]');
    if (await power.count() !== 1 || await slider.count() !== 1) {
      throw modelUnavailable('ChatGPT reasoning-effort control was not found exactly once');
    }
    await power.focus();
    let powerValue = Number(await slider.getAttribute('aria-valuenow'));
    if (!Number.isInteger(powerValue) || powerValue < 0 || powerValue > REQUIRED_POWER_VALUE) {
      throw modelUnavailable(`Unexpected ChatGPT reasoning-effort value: ${powerValue}`);
    }
    for (let step = 0; powerValue < REQUIRED_POWER_VALUE && step < REQUIRED_POWER_VALUE; step += 1) {
      await power.press('ArrowRight');
      await page.waitForTimeout(150);
      powerValue = Number(await slider.getAttribute('aria-valuenow'));
    }

    const effortStatus = (await menu.locator('[role="status"]').last().innerText()).trim();
    if (powerValue !== REQUIRED_POWER_VALUE || !REQUIRED_REVIEWER_EFFORT_STATUS.test(effortStatus)) {
      throw modelUnavailable(`Required ${REQUIRED_REVIEWER_EFFORT} reasoning effort could not be confirmed (${effortStatus})`);
    }
    if ((await modelOption.getAttribute('aria-checked')) !== 'true') {
      throw modelUnavailable(`${REQUIRED_REVIEWER_MODEL} was not selected after reasoning effort was set`);
    }

    await page.keyboard.press('Escape');
    menuOpened = false;
    const verifiedButtonLabel = (await selector.innerText()).trim();
    if (verifiedButtonLabel !== REQUIRED_REVIEWER_EFFORT) {
      throw modelUnavailable(`Model selector closed without showing ${REQUIRED_REVIEWER_EFFORT}`);
    }
    return { model: REQUIRED_REVIEWER_MODEL, effort: REQUIRED_REVIEWER_EFFORT };
  } catch (cause) {
    if (menuOpened) {
      try {
        await page.keyboard.press('Escape');
      } catch (closeError) {
        if (cause && typeof cause === 'object') cause.modelMenuCloseError = closeError;
      }
    }
    if (cause?.code === 'REVIEWER_MODEL_UNAVAILABLE') throw cause;
    throw modelUnavailable('Highest reviewer model could not be confirmed; action was not sent', cause);
  }
}
