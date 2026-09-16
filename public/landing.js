// Smoothly animates the FAQ <details>/<summary> accordion open/closed instead of the native
// instant snap. Uses the Web Animations API to tween the <details> element's own height between
// its collapsed (summary-only) and expanded (summary + answer) heights — the standard recipe for
// animating <details>, since browsers can't natively animate to/from `height: auto`. Semantics
// (keyboard toggling via Enter/Space on <summary>, screen readers, no-JS fallback to the native
// instant toggle) are all untouched; this only intercepts the click to animate it.
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('.home-faq-list details').forEach((details) => {
    const summary = details.querySelector('summary');
    const answer = details.querySelector('p');
    if (!summary || !answer || reduceMotion) return;

    let animation = null;
    let isClosing = false;
    let isExpanding = false;

    summary.addEventListener('click', (event) => {
      event.preventDefault();
      details.style.overflow = 'hidden';
      if (isClosing || !details.open) {
        openDetails();
      } else if (isExpanding || details.open) {
        shrink();
      }
    });

    function shrink() {
      isClosing = true;
      const startHeight = `${details.offsetHeight}px`;
      const endHeight = `${summary.offsetHeight}px`;
      if (animation) animation.cancel();
      animation = details.animate({ height: [startHeight, endHeight] }, { duration: 220, easing: 'ease-out' });
      animation.onfinish = () => onFinish(false);
      animation.oncancel = () => { isClosing = false; };
    }

    function openDetails() {
      details.style.height = `${details.offsetHeight}px`;
      details.open = true;
      requestAnimationFrame(expand);
    }

    function expand() {
      isExpanding = true;
      const startHeight = `${details.offsetHeight}px`;
      const endHeight = `${summary.offsetHeight + answer.offsetHeight}px`;
      if (animation) animation.cancel();
      animation = details.animate({ height: [startHeight, endHeight] }, { duration: 220, easing: 'ease-out' });
      animation.onfinish = () => onFinish(true);
      animation.oncancel = () => { isExpanding = false; };
    }

    function onFinish(open) {
      details.open = open;
      animation = null;
      details.style.height = '';
      details.style.overflow = '';
      isClosing = false;
      isExpanding = false;
    }
  });
})();
