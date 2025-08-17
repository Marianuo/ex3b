 const form = document.getElementById('run-form');
    const progressEl = document.getElementById('progress');
    const runBtn = document.getElementById('run-btn');
    const stopBtn = document.getElementById('stop-btn');
    let interval = null;

    function addLine(text, cls) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = text;
      progressEl.appendChild(div);
      progressEl.scrollTop = progressEl.scrollHeight;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      progressEl.textContent = '';
      addLine('Starting...');
      runBtn.disabled = true;
      stopBtn.disabled = false;

      const fd = new FormData(form);
      const res = await fetch('/process-video', { method: 'POST', body: fd });
      const { jobId, error } = await res.json();
      if (error) { addLine(error, 'err'); runBtn.disabled = false; stopBtn.disabled = true; return; }

      interval = setInterval(async () => {
        const s = await fetch(`/jobs/${jobId}/status`);
        const data = await s.json();

        if (data.error) {
          addLine(data.error, 'err');
          clearInterval(interval);
          runBtn.disabled = false;
          stopBtn.disabled = true;
          return;
        }

        (data.lines || []).forEach(l => {
          if (l.startsWith('[error]')) addLine(l, 'err');
          else if (l.startsWith('[alert]')) addLine(l, 'alert');
          else addLine(l);
        });

        if (data.done) {
          if (data.outputUrl) {
            const link = document.createElement('a');
            link.href = data.outputUrl;
            link.textContent = 'Download result';
            link.className = 'btn primary';
            progressEl.appendChild(link);
          }
          clearInterval(interval);
          runBtn.disabled = false;
          stopBtn.disabled = true;
        }
      }, 1000);

      // Stop button handler
      stopBtn.onclick = async () => {
        await fetch(`/jobs/${jobId}/stop`, { method: 'POST' });
        addLine('Job stopped by user.', 'alert');
        clearInterval(interval);
        runBtn.disabled = false;
        stopBtn.disabled = true;
      };
    });