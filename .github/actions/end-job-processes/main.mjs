// The action's main step only arms its post step (post.mjs), which runs last in the job (#421).
process.stdout.write("end-job-processes: armed; the job's leftover processes are judged after its last step\n");
