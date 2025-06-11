function goToStep(stepNumber) {
  for (let i = 1; i <= 5; i++) {
    const step = document.getElementById("step" + i);
    if (step) step.style.display = i === stepNumber ? "block" : "none";
  }
}
