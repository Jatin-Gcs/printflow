module.exports = {
  apps: [
    {
      name: "printflow-core",
      cwd: "/home/ubuntu/printflow/printflow-core",
      script: ".venv/bin/uvicorn",
      args: "app.main:app --host 0.0.0.0 --port 8000",
      interpreter: "none",
      env: {
        PATH: "/home/ubuntu/printflow/printflow-core/.venv/bin:" + process.env.PATH
      }
    }
  ]
};
